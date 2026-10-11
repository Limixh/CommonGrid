# Geliştirme rehberi

CommonGrid tam v1 hedefiyle geliştiriliyor. Şu an görev inceleme, hesap/katkı temeli, dosya teslimi, bağımsız doğrulayıcı bağlantısı, kalıcı profil seçimi, native CLI sürüm kontrolü ve Codex cihaz koduyla giriş ekranı var. Bağlı profille onaylı kontrollü görev akışı Windows uygulamasında gerçek Codex/Luna hesabıyla kabul edildi; arayüzde doğrulanmış diff gösteriliyor. Sıradaki iş Claude'un etkileşimli giriş yolunu tamamlamak; diğer platformlar ve daha geniş görev kapsamları [GO_GATE.md](GO_GATE.md) içinde takip edilir.

Bu dosya kurulum ve çalışma rehberidir. Tarihli test sonuçları ve önceki kararların uygulama kayıtları [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md) içinde korunur. Ürün gereksinimleri [spec'te](../PROJECT_SPEC1.2.md), planlanan fazlar [roadmap'te](../implementation_roadmap1.3.md), karar gerekçeleri [ADR'lerde](../spike/adr/) bulunur.

## Günlük geliştirme

```powershell
npm ci
npm run doctor
npm run dev
npm run check
```

Go kurulu değilse Windows'ta `./scripts/install-go.ps1` kullanılabilir. Proje araçları .tools, yerel durum/ham raporlar .local altındadır; Git'e alınmaz. Varsayılan sunucu örnek görevleri sunar. Hesap/DB modu [AUTHENTICATION.md](AUTHENTICATION.md), kaynak paketi ve yerel Trivy [ARTIFACTS.md](ARTIFACTS.md) içindedir.

Masaüstü kabuğu Windows'ta Rust, MSVC C++ araçları ve WebView2 ister. İsteğe bağlı `./scripts/install-rust.ps1` sonrası API'yi ayrı terminalde `npm run dev:api`, kabuğu `npm run desktop` ile başlatın. Native worker build'i Node 22 kullanır. Gerçek hesapla giriş tamamlama ve imzalı dağıtım kabulü ayrı doğrulanır.

Native CLI sürüm kontrolü için Docker Linux/amd64 engine, sabitlenmiş public imaj ve doğrulanmış CLI dosyaları gerekir. Geliştirme makinesinde aşağıdaki hazırlık yapılır; yalnız public araçlar indirilir, hesap dosyaları okunmaz:

```powershell
npm run install:cli-fixtures
docker pull $(node -p "require('./packages/agent-adapters/runtime-assets/native-cli-assets.lock.json').base_image")
npm run desktop
```

**Ajanlar ve ortam → CLI bağlantısını kontrol et**, yeni bir sandbox'ta yalnız CLI sürümünü sorgular ve ortamı kapatır. Giriş veya model çağrısı yapmaz. Build, public CLI cache'i yokken de derlenebilir; bu durumda kontrol eksik dosyayı bildirir. Runtime'da `.tools`, host hesabı veya PATH'teki Node'a geçilmez.

**Ajanlar ve ortam → Ajan profillerin**, profil adı ve Claude/Codex seçimini uygulamanın yerel veri dizinindeki `managed-profiles/profiles.json` dosyasına kaydeder. Seçim yeniden açılışta korunur. Bunlar hesap bağlantısı bekleyen tercihlerdir; profil ID'si CLI runtime sahibinin ID'si değildir ve bu kayıt Docker/auth kaynağı oluşturmaz. Aynı kaydın tekrarı idempotenttir; eski revision ve eşzamanlı uygulama yazıları çakışma olarak reddedilir. Bozuk kayıt otomatik sıfırlanmaz. Atomik yazma ve OS kilidi süreç kesintisini kapsar; güç kaybında dayanıklılık kabulü değildir.

Bir profil seçtikten sonra **Seçili profilin CLI hesabı** panelinde hesabı kontrol edin. **Codex hesabını bağla** yeni izole ortamı hazırlar; resmi giriş sayfasını açıp geçici kodu kendi hesabınızla onaylayın. Kod yalnız geçici arayüz durumudur; iptal, kapanış ve hata halinde gizlenir. Panelden çıkmak gözlenen giriş işlemini iptal etmeye çalışır. Hesap kontrolü ve çıkış, kayıtlı izole ortamı yeniden kullanır; bu işlemler model çağrısı yapmaz. Ortamı henüz oluşturulmamış bir profilin hesabı bağlı değildir. Claude'un bu panelden giriş işlemi terminal bağlantısı tamamlanana kadar desteklenmez.

**Onaylı görev** paneli seçili profilin hesap panelinin altındadır. Arayüz yalnız istek/profil kimliği, sabit `controlled-sum-integers-v1` görev kimliği ve `approved: true` gönderir; prompt, model, komut veya yol seçemez. Native taraf (`src-tauri/src/task_run.rs`) yalnız kayıtlı seçili profil için worker başlatır, 20 dakika süre sınırı, revision'a bağlı iptal ve 35 saniyelik bağımsız cleanup süresi uygular; hesap işlemi sürerken görev, görev sürerken hesap işlemi başlamaz. Worker (`native-worker/task-run.ts`) yalnız mevcut profil eşlemesini geri yükler, yeni hesap ortamı oluşturmaz; eşleme yoksa `profile_unbound` döner. Model işlev testi modelidir (Codex `gpt-6-luna`, Claude `haiku`); yoksa `model_unavailable` ile durur, başka modele geçmez. Sonuç yalnız 34 örnekli bağımsız doğrulayıcı geçtiğinde `passed` olur ve sınırlı diff taşır; doğrulanamayan cleanup `needs_review` olur ve aynı uygulama oturumunda yeni görevi engeller. Ortak sözleşme `packages/agent-adapters/src/task-run-protocol.ts`, kontrollü görev `controlled-task.ts`, sağlayıcı turu `controlled-task-session.ts` içindedir. Codex görevi sabitlenmiş model kataloğunu ister: `npm run install:cli-fixtures` public kaynağı sha256 doğrulamasıyla `.tools/cli-fixtures/codex-models.json` olarak indirir, `prepare:native-launcher` bunu `assets/codex-coding-catalog.json` olarak türetir; kaynak yoksa build geçer, Codex görevi `asset_missing` bildirir.

`managed-profile-sessions/<profile_id>.json` yalnız profil ID'si, sağlayıcı, ayrı runtime sahibi ve hazırlık durumu taşır. Resmi CLI auth verisi private Docker volume içinde kalır; host hesabı içe aktarılmaz. Yarım veya bozuk ortam eşlemesi yeniden sahiplenilmez, inceleme gerektirir. İşlem bittikten sonra container ve claim kapatılır, profil volume'leri sonraki giriş/kontrol için korunur. Native süre sınırı, sürüme bağlı iptal ve bağımsız cleanup uygulanır; hesap kimliği veya ham sağlayıcı çıktısı IPC'ye aktarılmaz.

Windows başlatıcısı Docker Desktop Linux motorunun sabit yerel named pipe'ını veya varsayılan Docker pipe'ını kullanır; host Docker context/credential dosyalarını okumaz. Özel/uzak Docker endpoint'i arayüzden seçilemez. Unix'te varsayılan yerel daemon gerekir; rootless/özel context ve gerçek native UI kabulü ayrı sınanır.

## Test komutları

| Komut | Neyi sınar? |
|---|---|
| npm run check | Şema üretimi, tipler, aşağıdaki ürün/deneme testleri ve web/Go derlemesi |
| npm run test:product | Ürün paketleri, Go sunucusu ve geliştirme araçları; gerçek AI yok |
| npm run test:spike-fixtures | CLI protokolü, oturum, kota, broker ve deneme sınırları; kayıtlı/sentetik cevaplar, gerçek AI yok |
| npm run test:db | Ayrılmış gerçek PostgreSQL; normal DATABASE_URL kullanılmaz |
| npm run test:ui | Önce install:browsers; tarayıcıda görev/hesap/katkı ve işlem günlüğü incelemesi |
| npm run test:native | Rust okuyucu ve IPC sınırı; yerel Rust toolchain gerekir |
| npm run test:native-smoke | Windows/WebView2 üzerinde paketlenmiş asset ve gerçek native günlük komutu; yeni sentetik uygulama diziniyle gizli pencere |
| npm run test:native-cli-smoke | Windows/WebView2 native başlatıcı, iki resmi CLI sürümü, idempotency, iptal, app-owned journal ve gerçek Docker cleanup; hesap/model yok |
| npm run test:native-profile-smoke | Windows/WebView2 üzerinde profil oluşturma/seçme ve aynı izole depoyla uygulama restart'ı; CLI, Docker veya hesap/model çağrısı yok |
| npm run test:native-session-smoke | Windows/WebView2 ve gerçek Docker üzerinde yeni izole Codex profilinde resmi cihaz kodu, giriş iptali ve hesapsız status/logout; kullanıcı yetkilendirmesi ve model çağrısı yok |
| npm run test:native-task-smoke | Windows/WebView2 üzerinde görev onayı, bağlı olmayan profil hatası ve hesapsız iptal/cleanup; varsayılan koşu model çağırmaz. `-- --real-account` yeni resmi girişten sonra yalnız bir Luna görevi, 34 örnek ve diff hash kontrolü çalıştırır |
| npm run test:artifacts | Önce install:trivy; gerçek gizli bilgi tarayıcısı ve dosya/verifier kontrolleri |
| npm run spike:session-continuity | Yeni hesapsız Docker profilleriyle kalıcı claim, restart, aynı profile yarış ve cleanup |
| npm run spike:owner-crash | Yeni sentetik profillerde gerçek host Node worker SIGKILL, işlem sahipliği ve açık orphan uzlaştırması; gerçek hesap/model yok |
| npm run spike:managed-adversarial | Hesapsız Docker saldırı ve kaynak sınırı senaryoları |
| npm run test:spike | Ayrı Temporal deneme modülünün testleri |
| node scripts/go.mjs vet ./... | Go statik kontrolü |

Gerçek hesabı kullanan komutlar olağan test paketinde çalışmaz. Testte Codex Luna ve Claude Haiku kullanılır; erişilemezse durulur. Kota kasıtlı tüketilmez, pahalı modele veya ücretli API'ye otomatik geçilmez. Ayrıntılar [AGENTS.md](../AGENTS.md) ve [izole oturum rehberinde](../spike/cli-session/MANAGED_SESSIONS.md).

Ürün birim testleri aynı anda en fazla dört test dosyası çalıştırır; çok sayıda Node sürecinin süre sınırı testleri üzerindeki yükünü azaltır. Native süreç testlerini tek tek çalıştırmak için `node scripts/rust.mjs test --locked -- --test-threads=1` kullanılabilir. Bu seçenekler uygulamanın görev veya temizleme süre sınırlarını değiştirmez.

## Kod ve değişiklik disiplini

Yeniden kullanılabilir CLI runtime/control, protokol/kota, kalıcı operation claim, faz günlüğü ve salt okunur kurtarma projection yardımcıları packages/agent-adapters içinde; gerçek hesap/Docker deneylerinin yöneticileri spike içinde kalır. Ürün kodu spike dosyalarını doğrudan içe aktarmamalıdır. Deneme testi ayrı isimle çalışır; npm run check güvenlik regresyonlarını da kapsar.

Resmi sağlayıcı oturum işlemleri `packages/agent-adapters/src/provider-session.ts` içindedir. Codex cihaz kodu yalnız açık seçilen geçici callback'e iletilir; ürün modülü varsayılan olarak yazdırmaz ve kalıcı kayıt üretmez. Native worker aynı modülü kullanır, tarayıcıya yalnız dar `profile-session` sözleşmesi ile bağlanır. Deneme terminali ince bir wrapper ile kodu kullanıcıya gösterir. Claude'un mevcut giriş yolu kullanıcı terminali gerektirir.

**Ajanlar ve ortam → Yerel işlem günlüğü**, native masaüstü uygulamasında uygulamanın yerel veri dizinindeki `managed-operation-journal` kayıtlarını okur; native CLI kontrolü aynı depoya yazar. Browser geliştirme görünümü `.local/managed-operation-journal` dizinini kullanır. Native hata halinde browser deposuna geçilmez; dizinler otomatik birleştirilmez veya taşınmaz. Yenileme yalnız okur; inceleme isteği kimlik ve revision/hash taşır. Kayıt yokluğu temiz ortam kanıtı değildir. Başlatıcı [ADR 0019](../spike/adr/0019-native-owned-cli-version-check.md), okuma bağlantısı [ADR 0018](../spike/adr/0018-native-operation-journal-status.md), disk/kesinti sınırları [ADR 0017](../spike/adr/0017-operation-phase-journal-and-recovery-review.md) içindedir.

Şema değişirse npm run generate çalıştırın; üretilen TS/Go tiplerini ve standalone doğrulayıcıları elle düzenlemeyin. Şema doğrulama kodu derleme sırasında üretilir; masaüstü güvenlik politikası runtime JavaScript derlemesine izin vermez. İlgili kontrolü geçen her tamamlanmış adım anlamlı bir yerel commit alır. Secret/auth, araç cache'i ve ham loglar commit edilmez; kullanıcı istemedikçe push yapılmaz. Yeni bir bulgu, sonuç kapsamıyla birlikte ayrı rapor/ADR'ye yazılır; geçmiş raporların model veya test sonucu değiştirilmez.

Güncel kabul durumu [GO_GATE.md](GO_GATE.md), kanıt dizini [raporlar](../spike/results/README.md), tarihçe [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md).
