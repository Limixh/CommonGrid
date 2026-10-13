# Geliştirme rehberi

CommonGrid tam v1 hedefiyle geliştiriliyor. Şu an görev inceleme, hesap/katkı temeli, dosya teslimi, bağımsız doğrulayıcı bağlantısı, kalıcı profil seçimi, native CLI sürüm kontrolü ve Codex/Claude resmi giriş ekranları var. Bağlı profille onaylı kontrollü görev akışı Windows uygulamasında gerçek Codex/Luna ve Claude/Haiku hesaplarıyla kabul edildi; arayüzde 34 örnekten geçen diff gösteriliyor. Claude'un uygulama içi resmi girişi de gerçek hesapla doğrulandı; diğer platformlar ve daha geniş görev kapsamları [GO_GATE.md](GO_GATE.md) içinde takip edilir.

Bu dosya kurulum ve çalışma rehberidir. Tarihli test sonuçları ve önceki kararların uygulama kayıtları [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md) içinde korunur. Ürün gereksinimleri [spec'te](../PROJECT_SPEC1.2.md), planlanan fazlar [roadmap'te](../implementation_roadmap1.3.md), karar gerekçeleri [ADR'lerde](../spike/adr/) bulunur.

Çalışma alanındaki yerel görev kartı profil, hesap ve görev onayı ekranına bağlanır. Katalogdaki **Profil seçimini hazırla** işlemi görev sürümü/hash'i ve seçilen yaklaşımın sabit bir kopyasını tutar; mevcut katalog örneklerine çalıştırma desteği vermez. Görev/profil değişimi önceki onayı temizler. Özel katalog seçimleri CommonGrid oturumu sona erince temizlenir; yerel ajan hesabı ayrı yönetilir.

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

Bir profil seçtikten sonra **Seçili profilin CLI hesabı** panelinde hesabı kontrol edin. **Codex hesabını bağla** yeni izole ortamı hazırlar; resmi giriş sayfasını açıp geçici kodu kendi hesabınızla onaylayın. **Claude hesabını bağla** için **Claude giriş sayfasını aç** düğmesini kullanın; native taraf yalnız etkin giriş isteğinin doğrulanmış resmi yetkilendirme URL'sini açar. Sayfanın verdiği geçici kodu yalnız uygulamadaki maskeli alana yapıştırıp **Giriş kodunu gönder** düğmesine basın; sohbete veya günlüğe yazmayın. Kod etkin istek/revision'a bağlı olarak bir kez worker stdin'ine iletilir; giriş sonucu resmi CLI durum kontrolüyle belirlenir. Geçici giriş bilgisi süre dolması, iptal, kapanış ve hata halinde temizlenir. Panelden çıkmak gözlenen giriş işlemini iptal etmeye çalışır. Hesap kontrolü ve çıkış kayıtlı izole ortamı yeniden kullanır; model çağrısı yapmaz. Ortamı henüz oluşturulmamış bir profilin hesabı bağlı değildir.

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
| npm run test:native-cloud-ui | Windows/WebView2: gerçek PostgreSQL/coordinator ile 65 görev, sayfalama, bağımlılık ve katkı/checkpoint panelleri; 780 px izole gizli debug uygulaması. OAuth kimliği ve verifier açık fixture; model çağrısı yok |
| npm run test:ui | Önce install:browsers; tarayıcıda görev/hesap/katkı ve işlem günlüğü incelemesi |
| npm run test:native | Rust okuyucu ve IPC sınırı; yerel Rust toolchain gerekir |
| npm run test:native-smoke | Windows/WebView2 üzerinde paketlenmiş asset ve gerçek native günlük komutu; yeni sentetik uygulama diziniyle gizli pencere |
| npm run test:native-cli-smoke | Windows/WebView2 native başlatıcı, iki resmi CLI sürümü, idempotency, iptal, app-owned journal ve gerçek Docker cleanup; hesap/model yok |
| npm run test:native-profile-smoke | Windows/WebView2 üzerinde profil oluşturma/seçme ve aynı izole depoyla uygulama restart'ı; CLI, Docker veya hesap/model çağrısı yok |
| npm run test:native-session-smoke | Windows/WebView2 ve gerçek Docker üzerinde yeni izole profilde resmi giriş challenge'ı, iptal ve hesapsız status/logout; kullanıcı yetkilendirmesi ve model çağrısı yok. `-- --provider claude` Claude'u seçer; varsayılan Codex. `-- --provider claude --exercise-browser` görünür uygulamadan resmi sayfayı açar, 30 saniye girişin beklemeye devam ettiğini sınar, sonra iptal eder; kod alanı boş kalır |
| npm run test:native-task-smoke | Windows/WebView2 üzerinde görev onayı, bağlı olmayan profil hatası ve hesapsız iptal/cleanup; varsayılan koşu model çağırmaz. `-- --real-account` yalnız bir Luna görevi çalıştırır. `-- --provider claude --real-account --show` resmi girişi maskeli uygulama alanıyla tamamladıktan sonra yalnız bir Haiku görevi, 34 örnek ve diff hash kontrolü çalıştırır. `-- --provider claude --real-account --reuse-session <v4 UUID>` daha önce giriş yapılmış izole test deposunu resmi status ile doğrular, yeni rapor dizininde tek Haiku görevi çalıştırır; bu modda `--show` isteğe bağlıdır |
| npm run test:artifacts | Önce install:trivy; gerçek gizli bilgi tarayıcısı ve dosya/verifier kontrolleri |
| npm run spike:session-continuity | Yeni hesapsız Docker profilleriyle kalıcı claim, restart, aynı profile yarış ve cleanup |
| npm run spike:owner-crash | Yeni sentetik profillerde gerçek host Node worker SIGKILL, işlem sahipliği ve açık orphan uzlaştırması; gerçek hesap/model yok |
| npm run spike:managed-adversarial | Hesapsız Docker saldırı ve kaynak sınırı senaryoları |
| npm run test:spike | Ayrı Temporal deneme modülünün testleri |
| node scripts/go.mjs vet ./... | Go statik kontrolü |

Native smoke aracı koşu bittiğinde kendi izole penceresini kapatır. 2026-10-13 tarihli [ayrı model kullanmayan native pencere kontrolünde](../spike/results/native-task-haiku-windows-2026-10-13.json) onay kutusu Başlat düğmesini açıp kapattı; Başlat tıklanmadı, görev oluşturulmadı ve pencere en az 30 saniye açık kaldıktan sonra açık bırakıldı. Bu kontrol gerçek Haiku görev kabulünden ayrıdır.

Gerçek hesabı kullanan komutlar olağan test paketinde çalışmaz. Testte Codex Luna ve Claude Haiku kullanılır; erişilemezse durulur. Kota kasıtlı tüketilmez, pahalı modele veya ücretli API'ye otomatik geçilmez. Ayrıntılar [AGENTS.md](../AGENTS.md) ve [izole oturum rehberinde](../spike/cli-session/MANAGED_SESSIONS.md).

Ürün birim testleri aynı anda en fazla dört test dosyası çalıştırır; çok sayıda Node sürecinin süre sınırı testleri üzerindeki yükünü azaltır. Native süreç testlerini tek tek çalıştırmak için `node scripts/rust.mjs test --locked -- --test-threads=1` kullanılabilir. Bu seçenekler uygulamanın görev veya temizleme süre sınırlarını değiştirmez.

## GitHub üzerinde CI

CI (sürekli entegrasyon), değişikliklerin GitHub makinelerinde derlenip test edilmesidir. Foundations; sözleşme/API/arayüz, PostgreSQL, artifact, Docker/CLI fixture ve Temporal kontrollerini, ayrıca Linux/Windows/macOS masaüstü test ve derlemelerini çalıştırır. Yerel kontrollerin kaçırabileceği platform farklarını yakalar; gerçek AI hesabı veya model çağrısı yapmaz.

2026-10-12 itibarıyla Actions dakika kotası dolduğu için Foundations GitHub üzerinde geçici olarak devre dışıdır. Repodaki tetikleyici yalnız `workflow_dispatch` olarak korunur; push veya pull request otomatik koşu başlatmaz. Test işleri silinmedi. Yerelde `npm run check`, `npm run test:db`, `npm run test:ui` ve gerektiğinde native/Docker kontrolleri çalıştırılmaya devam edilir.

Kota kullanılabilir olduğunda yeniden açmak için, aktif geliştirme dallarına da bu CI ayarını aktarın; ardından GitHub → Actions → Foundations → Enable workflow ve Run workflow ile `main` üzerinde elle başlatın. Workflow devre dışıyken elle de başlatılamaz. Uzak CI çalıştırılmadığında yerel başarı, Linux/macOS CI kabulü olarak raporlanmaz.

## Kod ve değişiklik disiplini

Yeniden kullanılabilir CLI runtime/control, protokol/kota, kalıcı operation claim, faz günlüğü ve salt okunur kurtarma projection yardımcıları packages/agent-adapters içinde; gerçek hesap/Docker deneylerinin yöneticileri spike içinde kalır. Ürün kodu spike dosyalarını doğrudan içe aktarmamalıdır. Deneme testi ayrı isimle çalışır; npm run check güvenlik regresyonlarını da kapsar.

Resmi sağlayıcı oturum işlemleri `packages/agent-adapters/src/provider-session.ts` içindedir. Codex cihaz kodu ve Claude yetkilendirme URL'si yalnız açık seçilen geçici callback'e iletilir; ürün modülü varsayılan olarak yazdırmaz ve kalıcı kayıt üretmez. Native worker aynı modülü kullanır, arayüze yalnız dar `profile-session` sözleşmesi ile bağlanır. Claude kodu uygulamadan istek/revision doğrulaması ve tek kullanımlık stdin kanalıyla alınır; ham giriş çıktısı veya kod günlüğe aktarılmaz. Deneme terminali ayrı bir wrapper kullanır; uygulama içi Claude girişi kullanıcı terminali gerektirmez.

**Ajanlar ve ortam → Yerel işlem günlüğü**, native masaüstü uygulamasında uygulamanın yerel veri dizinindeki `managed-operation-journal` kayıtlarını okur; native CLI kontrolü aynı depoya yazar. Browser geliştirme görünümü `.local/managed-operation-journal` dizinini kullanır. Native hata halinde browser deposuna geçilmez; dizinler otomatik birleştirilmez veya taşınmaz. Yenileme yalnız okur; inceleme isteği kimlik ve revision/hash taşır. Kayıt yokluğu temiz ortam kanıtı değildir. Başlatıcı [ADR 0019](../spike/adr/0019-native-owned-cli-version-check.md), okuma bağlantısı [ADR 0018](../spike/adr/0018-native-operation-journal-status.md), disk/kesinti sınırları [ADR 0017](../spike/adr/0017-operation-phase-journal-and-recovery-review.md) içindedir.

Şema değişirse npm run generate çalıştırın; üretilen TS/Go tiplerini ve standalone doğrulayıcıları elle düzenlemeyin. Şema doğrulama kodu derleme sırasında üretilir; masaüstü güvenlik politikası runtime JavaScript derlemesine izin vermez. İlgili kontrolü geçen her tamamlanmış adım anlamlı bir yerel commit alır. Secret/auth, araç cache'i ve ham loglar commit edilmez; kullanıcı istemedikçe push yapılmaz. Yeni bir bulgu, sonuç kapsamıyla birlikte ayrı rapor/ADR'ye yazılır; geçmiş raporların model veya test sonucu değiştirilmez.

Güncel kabul durumu [GO_GATE.md](GO_GATE.md), kanıt dizini [raporlar](../spike/results/README.md), tarihçe [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md).
