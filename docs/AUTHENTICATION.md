# CommonGrid hesabı ve kimlik doğrulamalı API

2026-10-08 · F0 uygulama temeli. CommonGrid hesabı GitHub veya Google kimliğiyle açılır. Bu hesap platformdaki katkı kayıtlarının sahibini belirler. Claude/Codex abonelik girişi ayrı, kullanıcının resmi CLI oturumudur; bu API AI hesabının kimlik bilgilerini almaz.

## Çalıştırma ve adresler

Varsayılan `CG_COORDINATOR_MODE=fixture` örnek katalog sunar; hesap sağlayıcıları kapalı, oturum anonimdir. Sahte geliştirme girişi yoktur. Veritabanı modunda proje/görev ve kişisel katkı uçları CommonGrid oturumu ister.

| Sunucu değişkeni | Anlamı |
|---|---|
| `CG_COORDINATOR_MODE` | `fixture` veya `authenticated`; varsayılan `fixture` |
| `DATABASE_URL` | Yalnız sunucunun PostgreSQL bağlantısı |
| `CG_DATABASE_SCHEMA` | Varsayılan `commongrid`; migration komutundaki schema ile aynı olmalı |
| `CG_PUBLIC_URL` | OAuth callback/API dış adresi; geliştirme varsayılanı `http://127.0.0.1:8787` |
| `CG_UI_ORIGIN` | Arayüzün tam origin'i; geliştirme varsayılanı `http://127.0.0.1:1420` |
| `CG_ALLOW_LOOPBACK_AUTH` | Yalnız yerel HTTP geliştirmesi için açıkça `true`; varsayılan kapalı |
| `CG_GITHUB_CLIENT_ID`, `CG_GITHUB_CLIENT_SECRET` | GitHub OAuth uygulamasının sunucu ayarları |
| `CG_GOOGLE_CLIENT_ID`, `CG_GOOGLE_CLIENT_SECRET` | Google web OAuth uygulamasının sunucu ayarları |

Bir sağlayıcının iki ayarı da eksikse giriş düğmesi kapalıdır; yalnız biri varsa sunucu güvenli hata ile başlamaz. Sırlar `VITE_*` değişkenlerine, frontend kaynaklarına veya loglara yazılmaz. Repository'de gerçek OAuth uygulama kaydı/client secret yoktur; gerçek hesap kabulü ayrıca yapılacaktır.

Geliştirmede `DATABASE_URL` ayrılmış yerel veritabanına ayarlandıktan sonra:

```powershell
npm run db:migrate
$env:CG_COORDINATOR_MODE = 'authenticated'
$env:CG_ALLOW_LOOPBACK_AUTH = 'true'
$env:CG_PUBLIC_URL = 'http://127.0.0.1:8787'
$env:CG_UI_ORIGIN = 'http://127.0.0.1:1420'
npm run dev
```

Özel schema için migration `node scripts/go.mjs run ./cmd/db --schema SCHEMA migrate` ile açıkça uygulanır. API startup migration çalıştırmaz; tüm kayıtlı migration adlarını ve SHA-256 değerlerini salt okunur kontrol eder.

Callback adresleri `${CG_PUBLIC_URL}/api/v1/auth/github/callback` ve `${CG_PUBLIC_URL}/api/v1/auth/google/callback` olarak sağlayıcı uygulamasında kaydedilir. Arayüz `/api` isteklerini aynı origin üzerinden yapar. Yerel Vite proxy mevcut API portuna yönlendirir ve Host'u hedefe çevirir. Çerezler host'a bağlı olduğundan iki adresin scheme ve hostname'i aynı olmalıdır; yalnız açık loopback geliştirmesinde portları farklı olabilir. `localhost` ile `127.0.0.1` karıştırılmaz.

Üretimde HTTPS, aynı origin'den UI ve `/api` sunan reverse proxy ve API'nin beklediği dış Host kullanılır. Koordinatör loopback dinler; forwarded başlıklarla güven kazanılmaz. Kimlik doğrulamalı, farklı hostname'e doğrudan browser fetch/CORS ve paketlenmiş Tauri için native auth dönüşü bu aşamada uygulanmadı.

## Hesap ve oturum sınırı

- GitHub authorization code + S256 PKCE; her girişte resmi `/user` cevabındaki sayısal kimlik tekrar okunur.
- Google authorization code + S256 PKCE + nonce; imza, issuer, audience, expiry, subject ve gerektiğinde `azp` doğrulanır. E-posta veya görünen isim hesapları birleştirmez.
- Login state ve tarayıcı bağı SHA-256 hash olarak tutulur; provider/verifier/nonce ile bağlı, en fazla on dakika ve tek kullanımlıdır. Callback sağlayıcıya gitmeden state'i atomik tüketir.
- Rastgele 32 byte oturum HttpOnly/SameSite=Lax çerezindedir; veritabanında yalnız hash bulunur. HTTPS çerezleri Secure'dur. Yeni başarılı giriş önceki browser oturumunu aynı transaction'da iptal eder; oturum en fazla 24 saattir. Çıkış sunucuda iptal eder.
- CSRF değeri yalnız oturum cevabından arayüz belleğine alınır. Yazmalar tam UI Origin ve `X-CSRF-Token` ister. Kişisel bilgiler/tokenlar localStorage/sessionStorage'a yazılmaz; oturum sona erdiğinde özel ekran verisi temizlenir.
- DB erişim hatası 503'tür; başarılı çıkış veya anonim oturum gibi gösterilmez. API kullanıcı kimliğini çerezden bulur; gövdedeki `user_id` kabul edilmez. Duplicate JSON alanları, bilinmeyen alanlar, belirsiz kimlik bilgileri ve sınırsız gövdeler reddedilir.

Google/GitHub access tokenları ve Google ID tokenı yalnız callback sırasında bellekte bulunur; kullanıcıya dönmez, DB'ye veya outbox'a yazılmaz. Refresh token istemeyen minimum profil kapsamı kullanılır. Sabit resmi HTTPS sağlayıcı uçları, timeout ve redirect reddi uygulanır.

## API uçları

| Uç | Yetki ve davranış |
|---|---|
| `GET /api/v1/auth/providers` | Yapılandırılmış sağlayıcıların açık/kapalı bilgisi |
| `GET /api/v1/auth/session` | Anonim durum veya hesabın kimliği, expiry ve bellekte kullanılacak CSRF |
| `GET /api/v1/auth/{provider}/start`, `.../callback` | Tarayıcı giriş akışı; yönlendirme hedefi sabittir |
| `POST /api/v1/auth/logout` | Oturum + Origin + CSRF ile iptal |
| `GET /api/v1/projects`, `/tasks`, `/tasks/{id}` | Giriş gerekli; gerçek DB kataloğu ve güncel immutable sözleşme |
| `GET /api/v1/me/leases`, `/me/submissions`, `/me/checkpoints` | Yalnız giriş yapan kişinin kayıtları |
| `GET /api/v1/leases/{id}`, `/submissions/{id}` | Yalnız kayıt sahibi; başkasına 404 |
| `GET /api/v1/checkpoints/{id}`, `/tasks/{id}/resume` | Domain'in immutable görev modu, kullanıcı, version/hash/base/strategy görünürlük kuralları |
| `GET /api/v1/reviews` | Güncel, inceleme bekleyen ve kişinin yetkili olduğu adayların metadata'sı |
| `POST /api/v1/leases/{id}/stop`, `/end` | Kendi mevcut lease'i; `/end` yalnız `stopped` veya `expired` |
| `POST /api/v1/leases/{id}/result` | Sonuç receipt'i ve aktif lease completion atomik; idempotent request key |
| `POST /api/v1/leases/{id}/checkpoint` | Mevcut lease'e bağlı şema doğrulanmış checkpoint metadata'sı |
| `POST /api/v1/leases/{id}/artifacts` | Oturum/Origin/CSRF ile binary kaynak paketi yükleme; purpose ve request_key query'de |
| `GET /api/v1/artifacts/{id}` | Yalnız sahibin dosya receipt'i; içerik ve dosya yolları verilmez |
| `POST /api/v1/submissions/{id}/review` | Kalıcı owner/grant yetkisi; kendi adayını incelemek yasak |
| `POST /api/v1/tasks/{id}/leases`, `/leases/{id}/start` | Varsayılan `409 isolation_gate_pending`; yalnız açık loopback geliştirme ayarında iki sabit yazılım sözleşmesine kiralama/başlatma yeteneği ([kurulum](DEVELOPMENT.md#merkezi-yazılım-görevi-gönderimi)) |
| `POST /api/v1/leases/{id}/heartbeat` | Aynı dar izin, sahip/aktif sözleşme/süre kontrolü; süre veya bütçe uzatmaz |

Listeler `limit=1..100` (varsayılan 50) ve `after` cursor kullanır; response `next_cursor` taşır. Arayüz katkı ekranı sonraki sayfayı açık seçimle yükler. DB proje tablosunda henüz editoryal title/description yoktur: başlık ID, açıklama boş ve tip güncel task türlerinden türetilir. Proje oluşturma/düzenleme paneli ve erişim/moderasyon politikaları sonraki ürün işidir.

Sonuç/hard checkpoint artık önceden yüklenmiş ready artifact kaydı ister; owner/lease/purpose/görev bağlamı ve hash/boyut aynı transaction içinde doğrulanır. Scanner/vault yapılandırması yoksa bu yazmalar 503 ile kapanır; metadata tek başına kabul edilmez. Yerel Trivy/vault kurulumu ve güvenilir verifier bağlantısı [ARTIFACTS.md](ARTIFACTS.md) içindedir. HTTP verifier claim/verdict, reviewer grant veya çalıştırma izni vermez. Genel harness, inceleme workspace'i ve final puan/merge akışı bekler.

## Doğrulama

`npm run test:db` yeni, ayrılmış PostgreSQL schema'larında gerçek flow/session/identity ve HTTP-domain zincirini sınar. Provider değişimi sahte fixture'dır. `npm run test:ui` hesap, katkı, hata/expiry/logout ve dar ekranı tarayıcıda sınar. `npm run check` ortak tip/şema, Go/Node testleri ve build'i kapsar.

Gerçek GitHub/Google OAuth uygulaması ve staging HTTPS girişi, paketlenmiş native dönüş, auth abuse/rate-limit/retention işletimi, üretim DB rol ayrımı ve uzak CI kabulü bekler. Bu temel tüm v1 hesabı veya CLI izolasyon GO kabulü değildir. Model çağrısı yapılmaz; uygulama işlevi için gerçek AI testine ihtiyaç olduğunda Luna/Haiku tercihi korunur.

Kaynaklar: [GitHub OAuth akışı](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Go OAuth2](https://pkg.go.dev/golang.org/x/oauth2), [CoreOS OIDC](https://pkg.go.dev/github.com/coreos/go-oidc/v3/oidc). Bağımlılıklar `go.mod`/`go.sum` ile sabittir.
