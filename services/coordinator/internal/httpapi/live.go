package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"strconv"
	"strings"

	"commongrid/coordinator/internal/auth"
	"commongrid/coordinator/internal/contract"
	"commongrid/coordinator/internal/store"
	"github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer"
)

// Repository excludes execution mutations, verifier verdicts and grants.
// Execution mutations require the separate, explicitly pinned capability.
type Repository interface {
	ListProjects(context.Context, int, string) ([]store.ProjectSummary, error)
	ListTasks(context.Context, string, int, string) ([]store.TaskRecord, error)
	Task(context.Context, string) (store.TaskRecord, error)
	ListUserLeases(context.Context, string, int, string) ([]store.Lease, error)
	ListUserSubmissions(context.Context, string, int, string) ([]store.Submission, error)
	ListUserCheckpoints(context.Context, string, int, string) ([]store.CheckpointRecord, error)
	ListReviews(context.Context, string, int, string) ([]store.Submission, error)
	Lease(context.Context, string, string) (store.Lease, error)
	RequestStop(context.Context, string, string) (store.Lease, error)
	End(context.Context, string, string, string) (store.Lease, error)
	Submit(context.Context, store.SubmitRequest) (store.Submission, error)
	Submission(context.Context, string, string) (store.Submission, error)
	SubmitCheckpoint(context.Context, store.SubmitCheckpointRequest) (store.CheckpointRecord, error)
	Checkpoint(context.Context, string, string) (store.CheckpointRecord, error)
	LatestUsableCheckpoint(context.Context, store.LatestCheckpointRequest) (store.CheckpointRecord, error)
	ReviewCandidate(context.Context, store.ReviewRequest) (store.Submission, error)
}

type Config struct {
	PublicURL          string
	UIOrigin           string
	Development        bool
	Artifacts          *ArtifactService
	ExecutionContracts []string
}

type sessionManager interface {
	Authenticate(*http.Request) (store.AuthSession, error)
	CheckCSRF(*http.Request, store.AuthSession) error
	Mount(*http.ServeMux)
}

type liveAPI struct {
	repo      Repository
	auth      sessionManager
	validator *contract.Validator
	artifacts *ArtifactService
	execution map[string]contract.TaskContract
}

var apiID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$`)
var apiHash = regexp.MustCompile(`^[a-f0-9]{64}$`)
var apiCommit = regexp.MustCompile(`^[a-f0-9]{40}$`)

func NewAuthenticated(repo Repository, manager *auth.Manager, options Config) (http.Handler, error) {
	if manager == nil {
		return nil, store.ErrInvalid
	}
	if err := manager.ValidateBoundary(options.PublicURL, options.UIOrigin, options.Development); err != nil {
		return nil, err
	}
	return newAuthenticated(repo, manager, options)
}

func validBoundary(raw string, development bool) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u == nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || (u.Path != "" && u.Path != "/") || u.RawPath != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, store.ErrInvalid
	}
	if u.Scheme == "http" {
		ip := net.ParseIP(u.Hostname())
		if !development || (u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback())) {
			return nil, store.ErrInvalid
		}
	}
	if u.Port() != "" {
		if _, err := net.LookupPort("tcp", u.Port()); err != nil {
			return nil, store.ErrInvalid
		}
	}
	u.Host = strings.ToLower(u.Host)
	return u, nil
}

func newAuthenticated(repo Repository, manager sessionManager, options Config) (http.Handler, error) {
	if repo == nil || (reflect.ValueOf(repo).Kind() == reflect.Pointer && reflect.ValueOf(repo).IsNil()) || manager == nil {
		return nil, store.ErrInvalid
	}
	public, err := validBoundary(options.PublicURL, options.Development)
	if err != nil {
		return nil, err
	}
	ui, err := validBoundary(options.UIOrigin, options.Development)
	if err != nil {
		return nil, err
	}
	options.UIOrigin = ui.Scheme + "://" + ui.Host
	validator, err := contract.NewValidator()
	if err != nil {
		return nil, err
	}
	if options.Artifacts != nil && options.Artifacts.DevelopmentOnly && !options.Development {
		return nil, store.ErrInvalid
	}
	execution, err := configuredExecution(repo, options)
	if err != nil {
		return nil, err
	}
	a := &liveAPI{repo: repo, auth: manager, validator: validator, artifacts: options.Artifacts, execution: execution}
	mux := http.NewServeMux()
	manager.Mount(mux)
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		write(w, 200, map[string]any{"status": "ok", "service": "coordinator", "mode": "authenticated", "source": "database", "execution_enabled": false})
	})
	a.mount(mux)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { write(w, 404, map[string]string{"code": "not_found"}) })
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		// Host is checked directly; forwarded headers never establish trust.
		if r.Host != public.Host {
			write(w, 403, map[string]string{"code": "invalid_host"})
			return
		}
		origins := r.Header.Values("Origin")
		if len(origins) > 1 || (len(origins) == 1 && (origins[0] == "" || origins[0] != options.UIOrigin)) {
			write(w, 403, map[string]string{"code": "invalid_origin"})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != http.MethodGet && r.Method != http.MethodPost {
			write(w, 405, map[string]string{"code": "method_not_allowed"})
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && len(origins) != 1 {
			write(w, 403, map[string]string{"code": "invalid_origin"})
			return
		}
		mux.ServeHTTP(w, r)
	}), nil
}

func (a *liveAPI) secured(handler func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		session, err := a.auth.Authenticate(r)
		if errors.Is(err, auth.ErrUnavailable) {
			write(w, 503, map[string]string{"code": "authentication_unavailable"})
			return
		}
		if errors.Is(err, auth.ErrForbidden) {
			write(w, 403, map[string]string{"code": "invalid_credentials"})
			return
		}
		if err != nil || session.UserID == "" {
			write(w, 401, map[string]string{"code": "unauthenticated"})
			return
		}
		if r.Method == http.MethodPost {
			if len(r.Header.Values("X-CSRF-Token")) != 1 || a.auth.CheckCSRF(r, session) != nil {
				write(w, 403, map[string]string{"code": "csrf_failed"})
				return
			}
		}
		if id := r.PathValue("id"); id != "" && !apiID.MatchString(id) {
			apiError(w, store.ErrInvalid)
			return
		}
		handler(w, r, session.UserID)
	}
}

func query(r *http.Request, names ...string) (url.Values, error) {
	v, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, store.ErrInvalid
	}
	allowed := make(map[string]bool, len(names))
	for _, n := range names {
		allowed[n] = true
	}
	for k, values := range v {
		if !allowed[k] || len(values) != 1 {
			return nil, store.ErrInvalid
		}
	}
	return v, nil
}

func page(r *http.Request, extras ...string) (url.Values, int, string, error) {
	v, err := query(r, append([]string{"limit", "after"}, extras...)...)
	if err != nil {
		return nil, 0, "", err
	}
	limit := 50
	if raw, exists := v["limit"]; exists {
		limit, err = strconv.Atoi(raw[0])
		if err != nil || limit < 1 || limit > 100 || strconv.Itoa(limit) != raw[0] {
			return nil, 0, "", store.ErrInvalid
		}
	}
	after := v.Get("after")
	if after != "" && !apiID.MatchString(after) {
		return nil, 0, "", store.ErrInvalid
	}
	return v, limit, after, nil
}

func envelope(w http.ResponseWriter, items any, next string) {
	write(w, 200, map[string]any{"source": "database", "execution_enabled": false, "items": items, "next_cursor": next})
}

func item(w http.ResponseWriter, value any, err error) {
	if err != nil {
		apiError(w, err)
		return
	}
	write(w, 200, map[string]any{"source": "database", "execution_enabled": false, "item": value})
}

func (a *liveAPI) mount(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/projects", a.secured(func(w http.ResponseWriter, r *http.Request, _ string) {
		_, limit, after, err := page(r)
		if err != nil {
			apiError(w, err)
			return
		}
		items, err := a.repo.ListProjects(r.Context(), limit, after)
		if err != nil {
			apiError(w, err)
			return
		}
		if items == nil {
			items = []store.ProjectSummary{}
		}
		next := ""
		if len(items) == limit {
			next = items[len(items)-1].ID
		}
		envelope(w, items, next)
	}))
	mux.HandleFunc("GET /api/v1/tasks", a.secured(func(w http.ResponseWriter, r *http.Request, _ string) {
		v, limit, after, err := page(r, "project_id")
		if err != nil || (v.Get("project_id") != "" && !apiID.MatchString(v.Get("project_id"))) {
			apiError(w, store.ErrInvalid)
			return
		}
		records, err := a.repo.ListTasks(r.Context(), v.Get("project_id"), limit, after)
		if err != nil {
			apiError(w, err)
			return
		}
		items := make([]contract.TaskContract, 0, len(records))
		statuses := map[string]string{}
		capabilities := map[string]ExecutionCapability{}
		for _, record := range records {
			items = append(items, record.Contract)
			statuses[record.Contract.Id] = record.Status
			if capability, ok := a.executionCapability(record); ok {
				capabilities[record.Contract.Id] = capability
			}
		}
		next := ""
		if len(records) == limit {
			next = records[len(records)-1].Contract.Id
		}
		write(w, 200, map[string]any{"source": "database", "execution_enabled": false, "execution_capabilities": capabilities, "items": items, "statuses": statuses, "next_cursor": next})
	}))
	mux.HandleFunc("GET /api/v1/tasks/{id}", a.secured(func(w http.ResponseWriter, r *http.Request, _ string) {
		if _, err := query(r); err != nil {
			apiError(w, err)
			return
		}
		record, err := a.repo.Task(r.Context(), r.PathValue("id"))
		if err != nil {
			apiError(w, err)
			return
		}
		capabilities := map[string]ExecutionCapability{}
		if capability, ok := a.executionCapability(record); ok {
			capabilities[record.Contract.Id] = capability
		}
		write(w, 200, map[string]any{"source": "database", "execution_enabled": false, "execution_capabilities": capabilities, "item": record.Contract, "statuses": map[string]string{record.Contract.Id: record.Status}})
	}))
	a.mountExecution(mux)
	mux.HandleFunc("GET /api/v1/me/leases", a.secured(func(w http.ResponseWriter, r *http.Request, user string) {
		_, limit, after, err := page(r)
		if err != nil {
			apiError(w, err)
			return
		}
		items, err := a.repo.ListUserLeases(r.Context(), user, limit, after)
		if err != nil {
			apiError(w, err)
			return
		}
		if items == nil {
			items = []store.Lease{}
		}
		next := ""
		if len(items) == limit {
			next = items[len(items)-1].ID
		}
		envelope(w, items, next)
	}))
	for _, path := range []string{"/api/v1/me/submissions", "/api/v1/reviews"} {
		mux.HandleFunc("GET "+path, a.secured(func(w http.ResponseWriter, r *http.Request, user string) {
			_, limit, after, err := page(r)
			if err != nil {
				apiError(w, err)
				return
			}
			var items []store.Submission
			if r.URL.Path == "/api/v1/reviews" {
				items, err = a.repo.ListReviews(r.Context(), user, limit, after)
			} else {
				items, err = a.repo.ListUserSubmissions(r.Context(), user, limit, after)
			}
			if err != nil {
				apiError(w, err)
				return
			}
			if items == nil {
				items = []store.Submission{}
			}
			next := ""
			if len(items) == limit {
				next = items[len(items)-1].ID
			}
			envelope(w, items, next)
		}))
	}
	mux.HandleFunc("GET /api/v1/me/checkpoints", a.secured(func(w http.ResponseWriter, r *http.Request, user string) {
		_, limit, after, err := page(r)
		if err != nil {
			apiError(w, err)
			return
		}
		items, err := a.repo.ListUserCheckpoints(r.Context(), user, limit, after)
		if err != nil {
			apiError(w, err)
			return
		}
		if items == nil {
			items = []store.CheckpointRecord{}
		}
		next := ""
		if len(items) == limit {
			next = items[len(items)-1].Metadata.CheckpointId
		}
		envelope(w, items, next)
	}))
	mux.HandleFunc("GET /api/v1/leases/{id}", a.secured(func(w http.ResponseWriter, r *http.Request, user string) {
		if _, err := query(r); err != nil {
			apiError(w, err)
			return
		}
		value, err := a.repo.Lease(r.Context(), user, r.PathValue("id"))
		item(w, value, err)
	}))
	mux.HandleFunc("GET /api/v1/submissions/{id}", a.secured(func(w http.ResponseWriter, r *http.Request, user string) {
		if _, err := query(r); err != nil {
			apiError(w, err)
			return
		}
		value, err := a.repo.Submission(r.Context(), user, r.PathValue("id"))
		item(w, value, err)
	}))
	mux.HandleFunc("GET /api/v1/checkpoints/{id}", a.secured(func(w http.ResponseWriter, r *http.Request, user string) {
		if _, err := query(r); err != nil {
			apiError(w, err)
			return
		}
		value, err := a.repo.Checkpoint(r.Context(), user, r.PathValue("id"))
		item(w, value, err)
	}))
	mux.HandleFunc("GET /api/v1/tasks/{id}/resume", a.secured(func(w http.ResponseWriter, r *http.Request, user string) {
		v, err := query(r, "task_version", "contract_hash", "base_commit", "strategy_id")
		if err != nil {
			apiError(w, err)
			return
		}
		version, err := strconv.ParseInt(v.Get("task_version"), 10, 64)
		if err != nil || version < 1 || strconv.FormatInt(version, 10) != v.Get("task_version") || !apiHash.MatchString(v.Get("contract_hash")) || !apiCommit.MatchString(v.Get("base_commit")) || !apiID.MatchString(v.Get("strategy_id")) {
			apiError(w, store.ErrInvalid)
			return
		}
		value, err := a.repo.LatestUsableCheckpoint(r.Context(), store.LatestCheckpointRequest{UserID: user, TaskID: r.PathValue("id"), TaskVersion: version, ContractHash: v.Get("contract_hash"), BaseCommit: v.Get("base_commit"), StrategyID: v.Get("strategy_id")})
		item(w, value, err)
	}))
	a.mountWrites(mux)
	a.mountArtifacts(mux)
}

func (a *liveAPI) mountWrites(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/leases/{id}/stop", a.secured(func(w http.ResponseWriter, r *http.Request, user string) {
		var dto struct{}
		if err := body(r, &dto); err != nil {
			apiError(w, err)
			return
		}
		value, err := a.repo.RequestStop(r.Context(), user, r.PathValue("id"))
		item(w, value, err)
	}))
	mux.HandleFunc("POST /api/v1/leases/{id}/end", a.secured(func(w http.ResponseWriter, r *http.Request, user string) {
		var dto struct {
			Reason string `json:"reason"`
		}
		if err := body(r, &dto); err != nil {
			apiError(w, err)
			return
		}
		// Completion must create its receipt atomically through /result. Ending
		// first would consume the lease and make a subsequent result invalid.
		if dto.Reason != "stopped" && dto.Reason != "expired" {
			apiError(w, store.ErrInvalid)
			return
		}
		value, err := a.repo.End(r.Context(), user, r.PathValue("id"), dto.Reason)
		item(w, value, err)
	}))
	mux.HandleFunc("POST /api/v1/leases/{id}/result", a.secured(func(w http.ResponseWriter, r *http.Request, user string) {
		var dto struct {
			TaskVersion  int64             `json:"task_version"`
			ContractHash string            `json:"contract_hash"`
			RequestKey   string            `json:"request_key"`
			BaseCommit   string            `json:"base_commit"`
			Artifact     store.ArtifactRef `json:"artifact"`
		}
		if err := body(r, &dto); err != nil {
			apiError(w, err)
			return
		}
		repo, ok := a.uploadedRepository(w)
		if !ok {
			return
		}
		value, err := repo.SubmitUploaded(r.Context(), store.SubmitRequest{UserID: user, LeaseID: r.PathValue("id"), TaskVersion: dto.TaskVersion, ContractHash: dto.ContractHash, RequestKey: dto.RequestKey, BaseCommit: dto.BaseCommit, Artifact: dto.Artifact})
		item(w, value, err)
	}))
	mux.HandleFunc("POST /api/v1/leases/{id}/checkpoint", a.secured(func(w http.ResponseWriter, r *http.Request, user string) {
		var dto struct {
			Checkpoint json.RawMessage   `json:"checkpoint"`
			Artifact   store.ArtifactRef `json:"artifact"`
			RequestKey string            `json:"request_key"`
		}
		if err := body(r, &dto); err != nil {
			apiError(w, err)
			return
		}
		metadata, err := a.validator.Checkpoint(dto.Checkpoint)
		if err != nil || metadata.LeaseId != r.PathValue("id") {
			apiError(w, store.ErrInvalid)
			return
		}
		repo, ok := a.uploadedRepository(w)
		if !ok {
			return
		}
		value, err := repo.SubmitUploadedCheckpoint(r.Context(), store.SubmitCheckpointRequest{UserID: user, RequestKey: dto.RequestKey, RawCheckpoint: dto.Checkpoint, Artifact: dto.Artifact})
		item(w, value, err)
	}))
	mux.HandleFunc("POST /api/v1/submissions/{id}/review", a.secured(func(w http.ResponseWriter, r *http.Request, user string) {
		var dto struct {
			Decision string `json:"decision"`
			Comments string `json:"comments"`
		}
		if err := body(r, &dto); err != nil {
			apiError(w, err)
			return
		}
		value, err := a.repo.ReviewCandidate(r.Context(), store.ReviewRequest{ReviewerID: user, SubmissionID: r.PathValue("id"), Decision: dto.Decision, Comments: dto.Comments})
		item(w, value, err)
	}))
}

const maxBody = 128 * 1024

func body(r *http.Request, target any) error {
	if _, err := query(r); err != nil {
		return err
	}
	if len(r.Header.Values("Content-Type")) != 1 || len(r.Header.Values("Content-Encoding")) != 0 || len(r.Header.Values("Content-Length")) > 1 || len(r.Header.Values("Transfer-Encoding")) > 1 {
		return store.ErrInvalid
	}
	media, parameters, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" || len(parameters) > 1 || (len(parameters) == 1 && !strings.EqualFold(parameters["charset"], "utf-8")) {
		return store.ErrInvalid
	}
	if r.ContentLength > maxBody {
		return store.ErrInvalid
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil || len(raw) > maxBody {
		return store.ErrInvalid
	}
	canonical, err := jsoncanonicalizer.Transform(raw)
	if err != nil || len(canonical) == 0 || canonical[0] != '{' {
		return store.ErrInvalid
	}
	if err = exactFields(raw, reflect.TypeOf(target).Elem()); err != nil {
		return store.ErrInvalid
	}
	// JCS validates duplicates and Unicode; decode the original bytes so its
	// IEEE-754 number normalization cannot alter a client's integer DTO values.
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(target); err != nil {
		return store.ErrInvalid
	}
	return nil
}

// encoding/json treats field names case-insensitively. Exact wire keys prevent
// two different spellings from overriding the same DTO field after JCS checks.
func exactFields(raw []byte, kind reflect.Type) error {
	if kind == reflect.TypeOf(json.RawMessage{}) {
		return nil
	}
	if kind.Kind() != reflect.Struct {
		if bytes.Equal(raw, []byte("null")) {
			return store.ErrInvalid
		}
		return nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return store.ErrInvalid
	}
	allowed := make(map[string]reflect.Type, kind.NumField())
	for i := 0; i < kind.NumField(); i++ {
		field := kind.Field(i)
		tag := strings.Split(field.Tag.Get("json"), ",")[0]
		if tag != "" && tag != "-" {
			allowed[tag] = field.Type
		}
	}
	for key, value := range fields {
		typ, exists := allowed[key]
		if !exists {
			return store.ErrInvalid
		}
		if err := exactFields(value, typ); err != nil {
			return err
		}
	}
	return nil
}

func apiError(w http.ResponseWriter, err error) {
	status, code := 500, "internal_error"
	switch {
	case errors.Is(err, store.ErrInvalid):
		status, code = 400, "invalid_request"
	case errors.Is(err, store.ErrNotFound):
		status, code = 404, "not_found"
	case errors.Is(err, store.ErrReviewDenied):
		status, code = 403, "review_not_authorized"
	case errors.Is(err, store.ErrConflict):
		status, code = 409, "idempotency_conflict"
	case errors.Is(err, store.ErrStale):
		status, code = 409, "stale_contract"
	case errors.Is(err, store.ErrClosed):
		status, code = 409, "lease_or_task_closed"
	case errors.Is(err, store.ErrCapacity):
		status, code = 429, "capacity_exhausted"
	case errors.Is(err, store.ErrBudget):
		status, code = 429, "budget_exhausted"
	}
	write(w, status, map[string]string{"code": code})
}
