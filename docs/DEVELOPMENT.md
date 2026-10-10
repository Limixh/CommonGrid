# Geliştirme rehberi

CommonGrid tam v1 hedefiyle geliştiriliyor. Şu an görev inceleme, hesap/katkı temeli, dosya teslimi, bağımsız doğrulayıcı bağlantısı, kalıcı profil seçimi ve native CLI sürüm kontrolü var. Sıradaki iş, yönetilen giriş ve doğrulanmış görev seçimini native başlatıcıya bağlamak; kalan kabul işleri [GO_GATE.md](GO_GATE.md) içinde takip edilir.

Bu dosya kurulum ve çalışma rehberidir. Tarihli test sonuçları ve önceki kararların uygulama kayıtları [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md) içinde korunur. Ürün gereksinimleri [spec'te](../PROJECT_SPEC1.2.md), planlanan fazlar [roadmap'te](../implementation_roadmap1.3.md), karar gerekçeleri [ADR'lerde](../spike/adr/) bulunur.

## Günlük geliştirme

```powershell
npm ci
npm run doctor
npm run dev
npm run check
```

Go kurulu değilse Windows'ta `./scripts/install-go.ps1` kullanılabilir. Proje araçları .tools, yerel durum/ham raporlar .local altındadır; Git'e alınmaz. Varsayılan sunucu örnek görevleri sunar. Hesap/DB modu [AUTHENTICATION.md](AUTHENTICATION.md), kaynak paketi ve yerel Trivy [ARTIFACTS.md](ARTIFACTS.md) içindedir.

Masaüstü kabuğu Windows'ta Rust, MSVC C++ araçları ve WebView2 ister. İsteğe bağlı `./scripts/install-rust.ps1` sonrası API'yi ayrı terminalde `npm run dev:api`, kabuğu `npm run desktop` ile başlatın. Native worker build'i Node 22 kullanır. Paketlenmiş native auth ve imzalı dağıtım kabulü henüz tamamlanmadı.

Native CLI sürüm kontrolü için Docker Linux/amd64 engine, sabitlenmiş public imaj ve doğrulanmış CLI dosyaları gerekir. Geliştirme makinesinde aşağıdaki hazırlık yapılır; yalnız public araçlar indirilir, hesap dosyaları okunmaz:

```powershell
npm run install:cli-fixtures
docker pull $(node -p "require('./packages/agent-adapters/runtime-assets/native-cli-assets.lock.json').base_image")
npm run desktop
```

**Ajanlar ve ortam → CLI bağlantısını kontrol et**, yeni bir sandbox'ta yalnız CLI sürümünü sorgular ve ortamı kapatır. Giriş veya model çağrısı yapmaz. Build, public CLI cache'i yokken de derlenebilir; bu durumda kontrol eksik dosyayı bildirir. Runtime'da `.tools`, host hesabı veya PATH'teki Node'a geçilmez.

**Ajanlar ve ortam → Ajan profillerin**, profil adı ve Claude/Codex seçimini uygulamanın yerel veri dizinindeki `managed-profiles/profiles.json` dosyasına kaydeder. Seçim yeniden açılışta korunur. Bunlar hesap bağlantısı bekleyen tercihlerdir; profil ID'si CLI runtime sahibinin ID'si değildir ve bu kayıt Docker/auth kaynağı oluşturmaz. Aynı kaydın tekrarı idempotenttir; eski revision ve eşzamanlı uygulama yazıları çakışma olarak reddedilir. Bozuk kayıt otomatik sıfırlanmaz. Atomik yazma ve OS kilidi süreç kesintisini kapsar; güç kaybında dayanıklılık kabulü değildir.

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
| npm run test:artifacts | Önce install:trivy; gerçek gizli bilgi tarayıcısı ve dosya/verifier kontrolleri |
| npm run spike:session-continuity | Yeni hesapsız Docker profilleriyle kalıcı claim, restart, aynı profile yarış ve cleanup |
| npm run spike:owner-crash | Yeni sentetik profillerde gerçek host Node worker SIGKILL, işlem sahipliği ve açık orphan uzlaştırması; gerçek hesap/model yok |
| npm run spike:managed-adversarial | Hesapsız Docker saldırı ve kaynak sınırı senaryoları |
| npm run test:spike | Ayrı Temporal deneme modülünün testleri |
| node scripts/go.mjs vet ./... | Go statik kontrolü |

Gerçek hesabı kullanan komutlar olağan test paketinde çalışmaz. Testte Codex Luna ve Claude Haiku kullanılır; erişilemezse durulur. Kota kasıtlı tüketilmez, pahalı modele veya ücretli API'ye otomatik geçilmez. Ayrıntılar [AGENTS.md](../AGENTS.md) ve [izole oturum rehberinde](../spike/cli-session/MANAGED_SESSIONS.md).

## Kod ve değişiklik disiplini

Yeniden kullanılabilir CLI runtime/control, protokol/kota, kalıcı operation claim, faz günlüğü ve salt okunur kurtarma projection yardımcıları packages/agent-adapters içinde; gerçek hesap/Docker deneylerinin yöneticileri spike içinde kalır. Ürün kodu spike dosyalarını doğrudan içe aktarmamalıdır. Deneme testi ayrı isimle çalışır; npm run check güvenlik regresyonlarını da kapsar.

Resmi sağlayıcı oturum işlemleri `packages/agent-adapters/src/provider-session.ts` içindedir. Codex cihaz kodu yalnız açık seçilen geçici callback'e iletilir; ürün modülü varsayılan olarak yazdırmaz ve kalıcı kayıt üretmez. Deneme terminali ince bir wrapper ile kodu kullanıcıya gösterir. Native giriş ekranının bağlantısı sonraki adımdır; Claude'un mevcut giriş yolu kullanıcı terminali gerektirir.

**Ajanlar ve ortam → Yerel işlem günlüğü**, native masaüstü uygulamasında uygulamanın yerel veri dizinindeki `managed-operation-journal` kayıtlarını okur; native CLI kontrolü aynı depoya yazar. Browser geliştirme görünümü `.local/managed-operation-journal` dizinini kullanır. Native hata halinde browser deposuna geçilmez; dizinler otomatik birleştirilmez veya taşınmaz. Yenileme yalnız okur; inceleme isteği kimlik ve revision/hash taşır. Kayıt yokluğu temiz ortam kanıtı değildir. Başlatıcı [ADR 0019](../spike/adr/0019-native-owned-cli-version-check.md), okuma bağlantısı [ADR 0018](../spike/adr/0018-native-operation-journal-status.md), disk/kesinti sınırları [ADR 0017](../spike/adr/0017-operation-phase-journal-and-recovery-review.md) içindedir.

Şema değişirse npm run generate çalıştırın; üretilen TS/Go tiplerini ve standalone doğrulayıcıları elle düzenlemeyin. Şema doğrulama kodu derleme sırasında üretilir; masaüstü güvenlik politikası runtime JavaScript derlemesine izin vermez. İlgili kontrolü geçen her tamamlanmış adım anlamlı bir yerel commit alır. Secret/auth, araç cache'i ve ham loglar commit edilmez; kullanıcı istemedikçe push yapılmaz. Yeni bir bulgu, sonuç kapsamıyla birlikte ayrı rapor/ADR'ye yazılır; geçmiş raporların model veya test sonucu değiştirilmez.

Güncel kabul durumu [GO_GATE.md](GO_GATE.md), kanıt dizini [raporlar](../spike/results/README.md), tarihçe [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md).
