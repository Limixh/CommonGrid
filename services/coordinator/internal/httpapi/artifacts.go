package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"reflect"
	"strconv"
	"sync"
	"time"

	"commongrid/coordinator/internal/artifact"
	"commongrid/coordinator/internal/store"
)

const ArtifactContentType = "application/vnd.commongrid.artifact+zip"
const maxArtifactBody int64 = 64 * 1024 * 1024
const artifactUploadTimeout = 30 * time.Second

// ArtifactVault accepts only server-generated opaque IDs, never client paths.
type ArtifactVault interface {
	Put(context.Context, string, []byte, string) error
}

// ArtifactScanner is independent of the bundle's mandatory baseline checks.
// Production must supply a real configured scanner; absence never means pass.
type ArtifactScanner interface {
	Scan(context.Context, *artifact.Bundle) error
}

var ErrArtifactScannerUnavailable = artifact.ErrScannerUnavailable

type ArtifactService struct {
	Vault             ArtifactVault
	Scanner           ArtifactScanner
	ScanPolicy        string
	ScanPolicyVersion string
	DevelopmentOnly   bool
	once              sync.Once
	slots             chan struct{}
}

type artifactRepository interface {
	RegisterArtifact(context.Context, store.ArtifactRegistration) (store.ArtifactRecord, error)
	MarkArtifactStored(context.Context, string, string, store.ArtifactRef) (store.ArtifactRecord, error)
	ArtifactForOwner(context.Context, string, string) (store.ArtifactRecord, error)
}

type uploadedRepository interface {
	SubmitUploaded(context.Context, store.SubmitRequest) (store.Submission, error)
	SubmitUploadedCheckpoint(context.Context, store.SubmitCheckpointRequest) (store.CheckpointRecord, error)
}

func absent(value any) bool {
	if value == nil {
		return true
	}
	v := reflect.ValueOf(value)
	return (v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface) && v.IsNil()
}

func (s *ArtifactService) ready() bool {
	return s != nil && !absent(s.Vault) && !absent(s.Scanner) && apiID.MatchString(s.ScanPolicy) && apiID.MatchString(s.ScanPolicyVersion)
}

func artifactUnavailable(w http.ResponseWriter, code string) {
	write(w, http.StatusServiceUnavailable, map[string]string{"code": code})
}

func (a *liveAPI) uploadedRepository(w http.ResponseWriter) (uploadedRepository, bool) {
	repo, ok := a.repo.(uploadedRepository)
	if !a.artifacts.ready() || !ok {
		artifactUnavailable(w, "artifact_storage_unavailable")
		return nil, false
	}
	return repo, true
}

func (a *liveAPI) mountArtifacts(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/leases/{id}/artifacts", a.secured(a.uploadArtifact))
	mux.HandleFunc("GET /api/v1/artifacts/{id}", a.secured(func(w http.ResponseWriter, r *http.Request, user string) {
		if _, err := query(r); err != nil {
			apiError(w, err)
			return
		}
		repo, ok := a.repo.(artifactRepository)
		if !a.artifacts.ready() || !ok {
			artifactUnavailable(w, "artifact_storage_unavailable")
			return
		}
		record, err := repo.ArtifactForOwner(r.Context(), user, r.PathValue("id"))
		if err != nil {
			apiError(w, err)
			return
		}
		// Return a bounded receipt, never bytes, file names, paths or credentials.
		item(w, struct {
			Artifact  store.ArtifactRef `json:"artifact"`
			Purpose   string            `json:"purpose"`
			State     string            `json:"state"`
			CreatedAt time.Time         `json:"created_at"`
		}{record.Artifact, record.Purpose, record.State, record.CreatedAt}, nil)
	}))
}

func artifactHeaders(r *http.Request) error {
	if len(r.Header.Values("Content-Type")) != 1 || len(r.Header.Values("Content-Encoding")) != 0 || len(r.Header.Values("Content-Length")) > 1 || len(r.Header.Values("Transfer-Encoding")) > 1 {
		return store.ErrInvalid
	}
	media, parameters, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != ArtifactContentType || len(parameters) != 0 {
		return store.ErrInvalid
	}
	if r.ContentLength > maxArtifactBody || r.ContentLength < -1 {
		return store.ErrInvalid
	}
	if lengths := r.Header.Values("Content-Length"); len(lengths) == 1 {
		length, err := strconv.ParseInt(lengths[0], 10, 64)
		if err != nil || length < 0 || strconv.FormatInt(length, 10) != lengths[0] || length != r.ContentLength {
			return store.ErrInvalid
		}
	}
	if len(r.TransferEncoding) > 1 || (len(r.TransferEncoding) == 1 && r.TransferEncoding[0] != "chunked") {
		return store.ErrInvalid
	}
	if encodings := r.Header.Values("Transfer-Encoding"); len(encodings) == 1 && encodings[0] != "chunked" {
		return store.ErrInvalid
	}
	if (len(r.TransferEncoding) != 0 || len(r.Header.Values("Transfer-Encoding")) != 0) && (r.ContentLength >= 0 || len(r.Header.Values("Content-Length")) != 0) {
		return store.ErrInvalid
	}
	return nil
}

func (a *liveAPI) uploadArtifact(w http.ResponseWriter, r *http.Request, user string) {
	v, err := query(r, "purpose", "request_key")
	if err != nil || (v.Get("purpose") != "result" && v.Get("purpose") != "checkpoint") || !apiID.MatchString(v.Get("request_key")) {
		apiError(w, store.ErrInvalid)
		return
	}
	if err := artifactHeaders(r); err != nil {
		apiError(w, err)
		return
	}
	repo, ok := a.repo.(artifactRepository)
	if a.artifacts == nil || absent(a.artifacts.Vault) || !ok {
		artifactUnavailable(w, "artifact_storage_unavailable")
		return
	}
	if !a.artifacts.ready() {
		artifactUnavailable(w, "artifact_scanner_unavailable")
		return
	}
	s := a.artifacts
	s.once.Do(func() { s.slots = make(chan struct{}, 4) })
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		artifactUnavailable(w, "artifact_upload_busy")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), artifactUploadTimeout)
	defer cancel()
	// Real HTTP connections enforce this deadline while bounded memory and the
	// context also protect scanner/storage work. Test writers may not support it.
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(artifactUploadTimeout))
	defer controller.SetReadDeadline(time.Time{})
	stopClose := context.AfterFunc(ctx, func() { _ = r.Body.Close() })
	defer stopClose()
	lease, err := a.repo.Lease(ctx, user, r.PathValue("id"))
	if err != nil {
		apiError(w, err)
		return
	}
	if lease.UserID != user || lease.ID != r.PathValue("id") {
		apiError(w, store.ErrNotFound)
		return
	}
	taskRecord, err := a.repo.Task(ctx, lease.TaskID)
	if err != nil {
		apiError(w, err)
		return
	}
	task := taskRecord.Contract
	if task.Id != lease.TaskID || task.TaskVersion != lease.TaskVersion || task.ContractHash != lease.ContractHash {
		apiError(w, store.ErrStale)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxArtifactBody+1))
	if err != nil || ctx.Err() != nil || int64(len(raw)) > maxArtifactBody || (r.ContentLength >= 0 && r.ContentLength != int64(len(raw))) {
		apiError(w, store.ErrInvalid)
		return
	}
	expected := artifact.Binding{TaskID: task.Id, TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, LeaseID: lease.ID, BaseCommit: task.Workspace.Commit, StrategyID: lease.StrategyID, Purpose: v.Get("purpose")}
	bundle, err := artifact.Validate(raw, task, expected)
	if err != nil {
		apiError(w, store.ErrInvalid)
		return
	}
	if err = s.Scanner.Scan(ctx, &bundle); err != nil {
		if errors.Is(err, ErrArtifactScannerUnavailable) || ctx.Err() != nil {
			artifactUnavailable(w, "artifact_scanner_unavailable")
		} else {
			write(w, http.StatusUnprocessableEntity, map[string]string{"code": "artifact_scan_rejected"})
		}
		return
	}
	if ctx.Err() != nil {
		artifactUnavailable(w, "artifact_scanner_unavailable")
		return
	}
	sum := sha256.Sum256(raw)
	ref := store.ArtifactRef{SHA256: hex.EncodeToString(sum[:]), SizeBytes: int64(len(raw))}
	identity, _ := json.Marshal([]string{user, lease.ID, v.Get("purpose"), v.Get("request_key"), ref.SHA256})
	idSum := sha256.Sum256(identity)
	ref.ID = "artifact-" + hex.EncodeToString(idSum[:16])
	registration := store.ArtifactRegistration{UserID: user, LeaseID: lease.ID, TaskID: task.Id, TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, BaseCommit: task.Workspace.Commit, StrategyID: lease.StrategyID, Purpose: v.Get("purpose"), RequestKey: v.Get("request_key"), ScanPolicy: s.ScanPolicy, ScanPolicyVersion: s.ScanPolicyVersion, Artifact: ref}
	record, err := repo.RegisterArtifact(ctx, registration)
	if err != nil {
		apiError(w, err)
		return
	}
	// Pending registration reserves quota before writing. Failed writes stay
	// unusable; an identical retry can complete the same immutable object.
	if record.Artifact != ref {
		apiError(w, store.ErrConflict)
		return
	}
	if err := s.Vault.Put(ctx, ref.ID, raw, ref.SHA256); err != nil {
		artifactUnavailable(w, "artifact_storage_unavailable")
		return
	}
	record, err = repo.MarkArtifactStored(ctx, user, ref.ID, ref)
	if err != nil {
		apiError(w, err)
		return
	}
	if record.Artifact != ref || record.State != "ready" {
		artifactUnavailable(w, "artifact_storage_unavailable")
		return
	}
	item(w, ref, nil)
}
