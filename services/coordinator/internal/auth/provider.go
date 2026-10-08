// Package auth implements browser login with durable one-use OAuth flows and
// opaque sessions. Provider access and identity tokens never leave this package.
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"commongrid/coordinator/internal/store"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer"
	"golang.org/x/oauth2"
)

var ErrProvider = errors.New("identity provider unavailable")

func NewGitHub(clientID, secret string) (Provider, error) {
	return NewGitHubProvider(clientID, secret, nil)
}

func NewGoogle(clientID, secret string) (Provider, error) {
	return NewGoogleProvider(clientID, secret, nil)
}

// Provider is injectable for local tests. Production constructors use only the
// official public service endpoints; configuration cannot replace those URLs.
type Provider interface {
	AuthorizationURL(state, verifier, nonce, redirectURI string) string
	Exchange(context.Context, string, string, string, string) (store.ExternalIdentity, error)
}

type provider struct {
	name     string
	config   oauth2.Config
	client   *http.Client
	verifier *oidc.IDTokenVerifier
}

type endpointTransport struct {
	base    http.RoundTripper
	allowed map[string]bool
}

func (t endpointTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != "https" || r.URL.User != nil || !t.allowed[r.URL.Scheme+"://"+r.URL.Host+r.URL.Path] {
		return nil, ErrProvider
	}
	return t.base.RoundTrip(r)
}

func providerClient(transport http.RoundTripper, endpoints ...string) *http.Client {
	if transport == nil {
		transport = http.DefaultTransport
	}
	allowed := make(map[string]bool, len(endpoints))
	for _, endpoint := range endpoints {
		allowed[endpoint] = true
	}
	return &http.Client{Transport: endpointTransport{transport, allowed}, Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func NewGitHubProvider(clientID, secret string, transport http.RoundTripper) (Provider, error) {
	if strings.TrimSpace(clientID) == "" || strings.TrimSpace(secret) == "" {
		return nil, ErrProvider
	}
	return &provider{name: "github", client: providerClient(transport,
		"https://github.com/login/oauth/access_token", "https://api.github.com/user"),
		config: oauth2.Config{ClientID: clientID, ClientSecret: secret,
			Endpoint: oauth2.Endpoint{AuthURL: "https://github.com/login/oauth/authorize",
				TokenURL: "https://github.com/login/oauth/access_token", AuthStyle: oauth2.AuthStyleInParams}}}, nil
}

func NewGoogleProvider(clientID, secret string, transport http.RoundTripper) (Provider, error) {
	if strings.TrimSpace(clientID) == "" || strings.TrimSpace(secret) == "" {
		return nil, ErrProvider
	}
	client := providerClient(transport, "https://oauth2.googleapis.com/token", "https://www.googleapis.com/oauth2/v3/certs")
	keyContext := oidc.ClientContext(context.Background(), client)
	keys := oidc.NewRemoteKeySet(keyContext, "https://www.googleapis.com/oauth2/v3/certs")
	return &provider{name: "google", client: client,
		verifier: oidc.NewVerifier("https://accounts.google.com", keys, &oidc.Config{ClientID: clientID, SupportedSigningAlgs: []string{"RS256"}}),
		config: oauth2.Config{ClientID: clientID, ClientSecret: secret, Scopes: []string{oidc.ScopeOpenID, "profile"},
			Endpoint: oauth2.Endpoint{AuthURL: "https://accounts.google.com/o/oauth2/v2/auth",
				TokenURL: "https://oauth2.googleapis.com/token", AuthStyle: oauth2.AuthStyleInParams}}}, nil
}

func (p *provider) AuthorizationURL(state, verifier, nonce, redirectURI string) string {
	config := p.config
	config.RedirectURL = redirectURI
	options := []oauth2.AuthCodeOption{oauth2.S256ChallengeOption(verifier)}
	if p.name == "google" {
		options = append(options, oidc.Nonce(nonce))
	}
	return config.AuthCodeURL(state, options...)
}

func (p *provider) Exchange(ctx context.Context, code, verifier, nonce, redirectURI string) (store.ExternalIdentity, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	ctx = context.WithValue(ctx, oauth2.HTTPClient, p.client)
	config := p.config
	config.RedirectURL = redirectURI
	token, err := config.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil || token.AccessToken == "" || !strings.EqualFold(token.TokenType, "bearer") {
		return store.ExternalIdentity{}, ErrProvider
	}
	if p.name == "google" {
		raw, ok := token.Extra("id_token").(string)
		if !ok || raw == "" {
			return store.ExternalIdentity{}, ErrProvider
		}
		id, err := p.verifier.Verify(ctx, raw)
		if err != nil || !validSubject(id.Subject) || nonce == "" || id.Nonce != nonce {
			return store.ExternalIdentity{}, ErrProvider
		}
		var claims struct {
			Name string `json:"name"`
			AZP  string `json:"azp"`
		}
		var payload json.RawMessage
		if id.Claims(&payload) != nil {
			return store.ExternalIdentity{}, ErrProvider
		}
		if _, err := jsoncanonicalizer.Transform(payload); err != nil {
			return store.ExternalIdentity{}, ErrProvider
		}
		if err := id.Claims(&claims); err != nil || (len(id.Audience) > 1 && claims.AZP == "") || (claims.AZP != "" && claims.AZP != p.config.ClientID) {
			return store.ExternalIdentity{}, ErrProvider
		}
		return store.ExternalIdentity{Provider: "google", Subject: id.Subject, DisplayName: displayName(claims.Name, "Google user")}, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user", nil)
	if err != nil {
		return store.ExternalIdentity{}, ErrProvider
	}
	req.Header.Set("Authorization", "Bearer "+token.AccessToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := p.client.Do(req)
	if err != nil {
		return store.ExternalIdentity{}, ErrProvider
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return store.ExternalIdentity{}, ErrProvider
	}
	var user struct {
		ID    int64  `json:"id"`
		Login string `json:"login"`
		Name  string `json:"name"`
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, (64<<10)+1))
	if err != nil || len(body) > 64<<10 {
		return store.ExternalIdentity{}, ErrProvider
	}
	if _, err := jsoncanonicalizer.Transform(body); err != nil {
		return store.ExternalIdentity{}, ErrProvider
	}
	if json.Unmarshal(body, &user) != nil || user.ID <= 0 || strings.TrimSpace(user.Login) == "" {
		return store.ExternalIdentity{}, ErrProvider
	}
	return store.ExternalIdentity{Provider: "github", Subject: strconv.FormatInt(user.ID, 10), DisplayName: displayName(user.Name, user.Login)}, nil
}

func displayName(name, fallback string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if name == "" {
		name = fallback
	}
	for len(name) > 320 {
		runes := []rune(name)
		name = string(runes[:len(runes)-1])
	}
	return name
}

func validSubject(subject string) bool {
	if len(subject) < 1 || len(subject) > 255 {
		return false
	}
	for _, r := range subject {
		if r < 33 || r > 126 {
			return false
		}
	}
	return true
}
