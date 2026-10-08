# CommonGrid

Kendi AI abonelikleriyle ortak matematik ve yazılım problemlerine katkı veren topluluk için masaüstü çalışma alanı.

Hedef, [ürün spesifikasyonundaki](PROJECT_SPEC1.2.md) tamamlanmış v1.0 kapsamıdır. Bu checkout Faz 0'ın ilk uygulamasıdır; ürün kapsamı MVP'ye indirilmemiştir.

Şu an Go koordinatörden görev yükleyen React çalışma alanı, Türkçe/İngilizce arayüz, görev filtreleri, sözleşme inceleme, yerel katkı tercihleri, ortam kontrolü ve Tauri 2 kabuğu vardır. CommonGrid GitHub/Google hesap temeli, kişisel katkı ekranı ve oturumla korunan PostgreSQL API bağlantısı eklendi. Görev, execution context, checkpoint ve planlayıcı önerisi JSON Schema'dan TypeScript/Go tipleri üretilir. Görev doğrulama ve RFC 8785 + SHA-256 hash'i iki dilde aynı örneklerle test edilir.

**Gerçek ajan çalıştırma açık değildir.** Varsayılan katalog `fixture` kaynaklıdır; örnek depolar, sıfır commit ve imaj digest'leri çalıştırılabilir kaynaklar değildir. `authenticated` modu giriş yapan kullanıcıya DB kataloğunu ve kendi katkı kayıtlarını sunar. Kimlik izolasyonu kapısı henüz değerlendirilmemiştir. Hesap girişi, CLI kurulumu veya konteyner testleri bu kapıyı açmaz. Gerçek OAuth sağlayıcı/staging kabulü, doğrulayıcı, orkestratör ve paketlenmiş native auth entegrasyonu henüz tamamlanmamıştır.

Kaynak paketi üretimi, oturumla korunan binary upload, immutable dosya kaydı/deposu, gerçek Trivy gizli bilgi taraması ve hash'e bağlı doğrulayıcı bağlantısı eklendi. Yerel geliştirme kurulumu ve production sınırları [dosya teslimi rehberinde](docs/ARTIFACTS.md). Genel Lean/yazılım harness'i ve production S3/scanner izolasyonu sonraki işlerdir.

## Geliştirme

Node.js 22.12+ ve Go 1.26+ gerekir. Windows'ta isteğe bağlı portable Go kurulumu yalnız `.tools` altına yazılır; sistem PATH'i değiştirilmez:

```powershell
./scripts/install-go.ps1
npm ci
npm run doctor
npm run dev
```

Arayüz: `http://127.0.0.1:1420` · Koordinatör: `http://127.0.0.1:8787/health`.

`npm run dev` iki süreci birlikte başlatır ve kapanırken alt süreçlerini durdurur. Yalnız arayüz için `npm run dev:ui`, yalnız API için `npm run dev:api` kullanılabilir. Her ikisi yalnız loopback dinler. Varsayılan fixture katalog salt okunur; tüm modlarda kiralama/start istekleri `409 isolation_gate_pending` döndürür. CommonGrid hesabı ve DB modu ayarları [kimlik doğrulama rehberinde](docs/AUTHENTICATION.md).

Masaüstü geliştirme için Windows'ta MSVC C++ araçları, WebView2 ve Rust gerekir. Rust'ı sisteme kurmak yerine proje içinde hazırlamak mümkündür:

```powershell
./scripts/install-rust.ps1
# Bir terminalde:
npm run dev:api
# Başka terminalde:
npm run desktop
```

Tauri kabuğunun şu anki çalışma biçimi geliştirme modudur. Paketlenmiş üretim uygulamasının API/auth bağlantısı ve imzalı dağıtımı daha sonra tamamlanacaktır. Kabuk shell veya dosya sistemi plugin'i açmaz.

## Kontroller

```powershell
npm run check
npm run install:browsers
npm run test:ui
node scripts/native.mjs build --no-bundle
npm run test:spike
npm run test:db
npm run install:trivy
npm run test:artifacts
```

`check`: üretilmiş dosya tutarlılığı, TypeScript tip kontrolü, Node/Go testleri, frontend ve Go derlemesi. Tarayıcı testleri ayrı olarak gerçek yerel API ile görev yükleme, filtreleme, JSON inceleme, dil, bütçe saklama, API hatası ve dar ekranı kontrol eder. Native derleme ayrıca Rust gerektirir. Üç platformlu CI tanımlıdır; yerelde çalıştırılmayan platformlar doğrulanmış sayılmaz.

Şema değişikliğinde `npm run generate`; fixture sözleşmelerini değiştirmek için `node scripts/create-fixtures.mjs` ardından `npm run generate` çalıştırılır. Üretilmiş dosyalar elle düzenlenmez.

## Açık kaynak kabul denemeleri

Temporal seçimi sunucudaki kalıcı iş akışları içindir; deneme API'den ayrı, fixture-only bir Go modülüdür. Docker gerektirmeyen portable development server ile gerçek kesinti testi:

```powershell
npm run install:temporal
npm run spike:recovery
npm run spike:routing
npm run spike:sandbox
npm run install:cli-fixtures
npm run spike:cli-session
npm run spike:managed-adversarial
npm run spike:session-continuity
npm run spike:coding-verifier
```

CLI ve Go cache'leri `.tools`, raporlar `.local` altında tutulur. `spike:routing` yalnız sürüm/help/engine ve sabit kaynak hash'lerini inceler. `spike:sandbox` gerçek Docker Linux görev konteynerinde 12 kontrol; `spike:cli-session` değiştirilmemiş Claude/Codex binary'leriyle ayrı CLI/task ortamlarında 20 protokol/araç/sahte kimlik kontrolü çalıştırır. Fixture model yanıtları yereldir. **Windows'ta açık abonelikle araçsız gerçek bağlantı** ayrıca `npm run spike:account-smoke` ile açıkça başlatılır; CI'da çalışmaz. İzole gerçek kodlama ve oturum kanıtları aşağıdaki managed hattında tutulur. Temporal recovery ve staging işletim kabulü ayrı kanıttır. Ayrıntılar: [Temporal](spike/temporal/README.md), [CLI araştırması](spike/cli-routing/README.md), [sandbox](spike/sandbox/README.md), [iki CLI denemesi](spike/cli-session/README.md), [bileşen seçimi](docs/OPEN_SOURCE_SELECTION.md).

[İzole resmi oturum hattı](spike/cli-session/MANAGED_SESSIONS.md) private Docker auth hacmi, readonly public CLI cache'i ve stdio provider egress kullanır. Önceki 16 boundary kontrolüne yeni sentetik saldırı paketi ve güçlendirilmiş artifact doğrulaması eklendi. Claude Sonnet 4.6 ve Codex `gpt-6-astra` dar profili önceki gerçek abonelik denemelerinde kod üretti; iki adayın her biri ayrı readonly verifier'da 32 örnek ve geçerli patch kontrolünü geçti. Codex resmi refresh isteği ve iki izole profile logout doğrulandı. Güncel güvenlik testleri yeni sentetik profillerle çalışır; eski hesap oturumlarını kullanmaz. Windows auth dosyaları taşınmadı. [Raporlar ve AI patch'leri](spike/results/README.md) ile [kapsam ve kalan kabul işleri](spike/adr/0007-adversarial-control-artifact-and-lifecycle.md) kaydedildi; Claude doğal yenilemesi ve geniş güvenlik kabulü beklediği için desktop/HTTP execution kapısı kapalıdır.

Son yerel kaynakla **167 Node testi** ve genel derleme/kontroller geçti. Yeni oturum sürekliliği paketi **Claude 9 + Codex 9 grupta** aynı profile contender/stale cleanup, restart, stopped uzlaştırma ve timeout/iptal sonrası alt süreç teardown'ı doğruladı. Runtime değişikliği sonrasında **Claude 11 + Codex 11 sentetik saldırı grubu** tekrar geçti. Önceki coding verifier 24 kontrol ve AI patch'lerinin gerçek apply/hash eşitliği kanıtları ayrı kalır. Import-safe oturum/kota yardımcıları ve ayrı, açık seçimli hesap kabul komutu [ADR 0008](spike/adr/0008-session-continuity-quota-and-operation-fencing.md) içindedir. Bunlar dar F0 kanıtlarıdır; doğal hesap yenilemesi/gerçek kota, uzak CI veya tam fizibilite kabulü sayılmaz. Kullanıcının kararıyla resmi CLI + kendi aboneliği tasarımı korunur; [uyumluluk incelemesi](docs/PROVIDER_COMPATIBILITY.md) kayıtlıdır.

## Yapı

| Konum | İçerik |
|---|---|
| `apps/desktop` | React/Vite arayüzü ve Tauri/Rust kabuğu |
| `services/coordinator` | Go API, katalog ve sunucu görev doğrulaması |
| `packages/task-schema` | Kaynak JSON Schema, doğrulayıcı, tipler, ortak test örnekleri |
| `packages/agent-adapters` | Claude/Codex olay normalizasyonu, kapalı task tool, süreç launcher'ı ve fixture-only task-tools runtime |
| `spike` | Mimari kararlar, uyumluluk ve güvenlik kanıtı planı |
| `docs` | Geliştirme durumu ve test bulguları |

Sonraki adımlar ve tamamlanmamış kabul kriterleri [geliştirme kaydında](docs/DEVELOPMENT.md). Fizibilite kapısı [spike kaydında](spike/README.md).

PostgreSQL migrations, atomik proje/dal rezervasyonu ve outbox teslimat temeli üzerine sonuç/checkpoint/inceleme/tek kazanan domain kayıtları eklendi. ADR 0009'un 44-test kaydı tarihli kanıttır; hesap/API katmanı ADR 0010 ile ayrı doğrulanır. Gerçek PostgreSQL testleri, development DB kurulumu ve kapsam sınırları [veritabanı rehberinde](docs/DATABASE.md), hesap kurulumu [kimlik doğrulama rehberinde](docs/AUTHENTICATION.md).
