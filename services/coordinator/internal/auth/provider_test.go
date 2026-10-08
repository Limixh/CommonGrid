package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func jsonResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}

func assertPKCE(t *testing.T, p Provider, authURL string, google bool) string {
	t.Helper()
	verifier, _ := randomToken()
	nonce, _ := randomToken()
	u, err := url.Parse(p.AuthorizationURL("state", verifier, nonce, "https://grid.example/api/v1/auth/provider/callback"))
	if err != nil {
		t.Fatal(err)
	}
	challenge := sha256.Sum256([]byte(verifier))
	q := u.Query()
	if u.Scheme+"://"+u.Host+u.Path != authURL || q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") != base64.RawURLEncoding.EncodeToString(challenge[:]) || q.Get("state") != "state" || q.Get("response_type") != "code" {
		t.Fatalf("unsafe authorize URL: %s", u)
	}
	if google && (q.Get("nonce") != nonce || q.Get("scope") != "openid profile") {
		t.Fatal("Google OIDC parameters missing")
	}
	if !google && q.Get("nonce") != "" {
		t.Fatal("unexpected github OIDC parameters")
	}
	return verifier
}

func TestGitHubOfficialCodeExchangeAndSubject(t *testing.T) {
	verifier := ""
	calls := 0
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		deadline, ok := r.Context().Deadline()
		if !ok || time.Until(deadline) > 20*time.Second {
			t.Fatal("exchange context not bounded")
		}
		switch r.URL.String() {
		case "https://github.com/login/oauth/access_token":
			if r.Method != "POST" {
				t.Fatal("token request method")
			}
			_ = r.ParseForm()
			if r.Form.Get("code_verifier") != verifier || r.Form.Get("code") != "code" || r.Form.Get("client_id") != "client" || r.Form.Get("client_secret") != "secret" || r.Form.Get("redirect_uri") != "https://grid.example/api/v1/auth/github/callback" {
				t.Fatal("token exchange binding lost")
			}
			return jsonResponse(200, `{"access_token":"ephemeral-provider-token","token_type":"bearer"}`), nil
		case "https://api.github.com/user":
			if r.Header.Get("Authorization") != "Bearer ephemeral-provider-token" {
				t.Fatal("identity request missing token")
			}
			return jsonResponse(200, `{"id":9007199254740993,"login":"handle","name":"Name","email":"untrusted@example.com"}`), nil
		default:
			t.Fatalf("unexpected provider endpoint %s", r.URL)
			return nil, ErrProvider
		}
	})
	p, err := NewGitHubProvider("client", "secret", transport)
	if err != nil {
		t.Fatal(err)
	}
	verifier = assertPKCE(t, p, "https://github.com/login/oauth/authorize", false)
	identity, err := p.Exchange(context.Background(), "code", verifier, "nonce", "https://grid.example/api/v1/auth/github/callback")
	if err != nil || identity.Subject != "9007199254740993" || identity.Provider != "github" || identity.DisplayName != "Name" || calls != 2 {
		t.Fatalf("identity %v %v", identity, err)
	}
	encoded, _ := json.Marshal(identity)
	if strings.Contains(string(encoded), "token") || strings.Contains(string(encoded), "email") {
		t.Fatal("identity leaked token/email")
	}
}

func TestGitHubMalformedAndFailedResponsesSanitized(t *testing.T) {
	for _, tc := range []struct {
		name                    string
		tokenBody               string
		userBody                string
		tokenStatus, userStatus int
		networkErr              bool
	}{
		{"token error", `{"error":"secret-provider-error"}`, `{}`, 400, 200, false},
		{"missing token", `{}`, `{}`, 200, 200, false},
		{"wrong token type", `{"access_token":"secret","token_type":"mac"}`, `{}`, 200, 200, false},
		{"malformed token", `{"access_token":123}`, `{}`, 200, 200, false},
		{"user failure", `{"access_token":"secret","token_type":"bearer"}`, `secret`, 200, 503, false},
		{"missing id", `{"access_token":"secret","token_type":"bearer"}`, `{"login":"x"}`, 200, 200, false},
		{"string id", `{"access_token":"secret","token_type":"bearer"}`, `{"id":"1","login":"x"}`, 200, 200, false},
		{"negative id", `{"access_token":"secret","token_type":"bearer"}`, `{"id":-1,"login":"x"}`, 200, 200, false},
		{"missing login", `{"access_token":"secret","token_type":"bearer"}`, `{"id":1}`, 200, 200, false},
		{"multiple bodies", `{"access_token":"secret","token_type":"bearer"}`, `{"id":1,"login":"x"}{}`, 200, 200, false},
		{"duplicate id", `{"access_token":"secret","token_type":"bearer"}`, `{"id":1,"id":2,"login":"x"}`, 200, 200, false},
		{"duplicate login", `{"access_token":"secret","token_type":"bearer"}`, `{"id":1,"login":"x","login":"y"}`, 200, 200, false},
		{"oversized trailing whitespace", `{"access_token":"secret","token_type":"bearer"}`, `{"id":1,"login":"x"}` + strings.Repeat(" ", 70<<10), 200, 200, false},
		{"oversized profile", `{"access_token":"secret","token_type":"bearer"}`, `{"id":1,"login":"` + strings.Repeat("a", 70<<10) + `"}`, 200, 200, false},
		{"network timeout", `{}`, `{}`, 200, 200, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, err := NewGitHubProvider("client", "secret", roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if tc.networkErr {
					return nil, context.DeadlineExceeded
				}
				if r.URL.Host == "github.com" {
					return jsonResponse(tc.tokenStatus, tc.tokenBody), nil
				}
				return jsonResponse(tc.userStatus, tc.userBody), nil
			}))
			if err != nil {
				t.Fatal(err)
			}
			_, err = p.Exchange(context.Background(), "code", "verifier", "nonce", "https://grid.example/callback")
			if !errors.Is(err, ErrProvider) || strings.Contains(err.Error(), "secret") {
				t.Fatalf("unsanitized error %v", err)
			}
		})
	}
}

func signIDToken(t *testing.T, key *rsa.PrivateKey, claims map[string]any) string {
	t.Helper()
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithHeader("kid", "fixture-key").WithType("JWT"))
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	signed, err := signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := signed.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestGoogleOIDCSignatureIssuerAudienceExpirySubjectNonce(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	otherKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := json.Marshal(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "fixture-key", Algorithm: "RS256", Use: "sig"}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []string{"valid", "multi_aud_valid", "multi_aud_missing_azp", "multi_aud_wrong_azp", "single_aud_wrong_azp", "bad_signature", "issuer", "audience", "expiry", "subject", "nonce", "missing_id_token", "wrong_id_shape"} {
		t.Run(mutation, func(t *testing.T) {
			claims := map[string]any{"iss": "https://accounts.google.com", "aud": "client", "sub": "subject-42", "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(), "nonce": "expected-nonce", "name": "Name", "email": "ignored@example.com"}
			signingKey := key
			switch mutation {
			case "bad_signature":
				signingKey = otherKey
			case "issuer":
				claims["iss"] = "https://evil.example"
			case "audience":
				claims["aud"] = "another-client"
			case "expiry":
				claims["exp"] = time.Now().Add(-time.Hour).Unix()
			case "subject":
				claims["sub"] = ""
			case "nonce":
				claims["nonce"] = "another-flow"
			case "multi_aud_valid":
				claims["aud"] = []string{"client", "other"}
				claims["azp"] = "client"
			case "multi_aud_missing_azp":
				claims["aud"] = []string{"client", "other"}
			case "multi_aud_wrong_azp":
				claims["aud"] = []string{"client", "other"}
				claims["azp"] = "other"
			case "single_aud_wrong_azp":
				claims["azp"] = "other"
			}
			raw := signIDToken(t, signingKey, claims)
			verifier := ""
			calls := 0
			transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				switch r.URL.String() {
				case "https://oauth2.googleapis.com/token":
					_ = r.ParseForm()
					if r.Form.Get("code_verifier") != verifier || r.Form.Get("grant_type") != "authorization_code" {
						t.Fatal("Google PKCE exchange missing")
					}
					response := map[string]any{"access_token": "ephemeral-access", "token_type": "Bearer", "id_token": raw}
					if mutation == "missing_id_token" {
						delete(response, "id_token")
					}
					if mutation == "wrong_id_shape" {
						response["id_token"] = 123
					}
					body, _ := json.Marshal(response)
					return jsonResponse(200, string(body)), nil
				case "https://www.googleapis.com/oauth2/v3/certs":
					return jsonResponse(200, string(keys)), nil
				default:
					t.Fatalf("unexpected Google endpoint %s", r.URL)
					return nil, ErrProvider
				}
			})
			p, err := NewGoogleProvider("client", "secret", transport)
			if err != nil {
				t.Fatal(err)
			}
			verifier = assertPKCE(t, p, "https://accounts.google.com/o/oauth2/v2/auth", true)
			identity, err := p.Exchange(context.Background(), "code", verifier, "expected-nonce", "https://grid.example/api/v1/auth/google/callback")
			if mutation == "valid" || mutation == "multi_aud_valid" {
				if err != nil || identity.Subject != "subject-42" || identity.Provider != "google" || identity.DisplayName != "Name" || calls != 2 {
					t.Fatalf("valid identity failed %v %v", identity, err)
				}
			} else if !errors.Is(err, ErrProvider) || identity.Subject != "" {
				t.Fatalf("bad token accepted %v %v", identity, err)
			}
		})
	}
}

func TestProviderTransportRejectsRedirectsAndUnapprovedEndpoints(t *testing.T) {
	calls := 0
	client := providerClient(roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://evil.example/steal"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
	}), "https://github.com/login/oauth/access_token")
	if client.Timeout != 10*time.Second {
		t.Fatal("external requests unbounded")
	}
	response, err := client.Get("https://github.com/login/oauth/access_token")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != 302 || calls != 1 {
		t.Fatal("redirect followed")
	}
	for _, endpoint := range []string{"http://github.com/login/oauth/access_token", "https://evil.example/steal", "https://github.com/other", "https://user:pass@github.com/login/oauth/access_token"} {
		if _, err := client.Get(endpoint); err == nil {
			t.Fatalf("unapproved endpoint accepted %s", endpoint)
		}
	}
	if calls != 1 {
		t.Fatal("blocked endpoint reached transport")
	}
	if _, err := NewGitHub("", "secret"); err == nil {
		t.Fatal("missing client accepted")
	}
	if _, err := NewGoogle("client", ""); err == nil {
		t.Fatal("missing secret accepted")
	}
}

func TestDisplayNameSanitizedWithinDatabaseLimit(t *testing.T) {
	name := displayName("\n"+strings.Repeat("😀", 200)+"\x00", "fallback")
	if len(name) > 320 || strings.ContainsAny(name, "\n\x00") {
		t.Fatal("display name invalid")
	}
	if displayName("\n\t", "fallback") != "fallback" {
		t.Fatal("empty display name fallback")
	}
}
