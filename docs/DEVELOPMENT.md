# Geliştirme rehberi

CommonGrid tam v1 hedefiyle geliştiriliyor. Şu an görev inceleme, hesap/katkı temeli, dosya teslimi ve bağımsız doğrulayıcı bağlantısı var. Uygulamadan yeni AI görevi başlatma kapalı; sıradaki öncelik [CLI izolasyonu kabulü](GO_GATE.md).

Bu dosya kurulum ve çalışma rehberidir. Tarihli test sonuçları ve önceki kararların uygulama kayıtları [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md) içinde korunur. Ürün gereksinimleri [spec'te](../PROJECT_SPEC1.2.md), planlanan fazlar [roadmap'te](../implementation_roadmap1.3.md), karar gerekçeleri [ADR'lerde](../spike/adr/) bulunur.

## Günlük geliştirme

```powershell
npm ci
npm run doctor
npm run dev
npm run check
```

Go kurulu değilse Windows'ta `./scripts/install-go.ps1` kullanılabilir. Proje araçları .tools, yerel durum/ham raporlar .local altındadır; Git'e alınmaz. Varsayılan sunucu örnek görevleri sunar. Hesap/DB modu [AUTHENTICATION.md](AUTHENTICATION.md), kaynak paketi ve yerel Trivy [ARTIFACTS.md](ARTIFACTS.md) içindedir.

Masaüstü kabuğu Windows'ta Rust, MSVC C++ araçları ve WebView2 ister. İsteğe bağlı `./scripts/install-rust.ps1` sonrası API'yi ayrı terminalde `npm run dev:api`, kabuğu `npm run desktop` ile başlatın. Paketlenmiş native auth ve imzalı dağıtım kabulü henüz tamamlanmadı.

## Test komutları

| Komut | Neyi sınar? |
|---|---|
| npm run check | Şema üretimi, tipler, aşağıdaki ürün/deneme testleri ve web/Go derlemesi |
| npm run test:product | Ürün paketleri, Go sunucusu ve geliştirme araçları; gerçek AI yok |
| npm run test:spike-fixtures | CLI protokolü, oturum, kota, broker ve deneme sınırları; kayıtlı/sentetik cevaplar, gerçek AI yok |
| npm run test:db | Ayrılmış gerçek PostgreSQL; normal DATABASE_URL kullanılmaz |
| npm run test:ui | Önce install:browsers; tarayıcıda görev/hesap/katkı akışı |
| npm run test:artifacts | Önce install:trivy; gerçek gizli bilgi tarayıcısı ve dosya/verifier kontrolleri |
| npm run spike:session-continuity | Yeni hesapsız Docker profilleriyle restart, işlem sahipliği ve cleanup |
| npm run spike:managed-adversarial | Hesapsız Docker saldırı ve kaynak sınırı senaryoları |
| npm run test:spike | Ayrı Temporal deneme modülünün testleri |
| node scripts/go.mjs vet ./... | Go statik kontrolü |

Gerçek hesabı kullanan komutlar olağan test paketinde çalışmaz. Testte Codex Luna ve Claude Haiku kullanılır; erişilemezse durulur. Kota kasıtlı tüketilmez, pahalı modele veya ücretli API'ye otomatik geçilmez. Ayrıntılar [AGENTS.md](../AGENTS.md) ve [izole oturum rehberinde](../spike/cli-session/MANAGED_SESSIONS.md).

## Kod ve değişiklik disiplini

Yeniden kullanılabilir protokol/kota yardımcıları packages/agent-adapters içinde; gerçek hesap/Docker deneylerinin yöneticileri spike içinde kalır. Ürün kodu spike dosyalarını doğrudan içe aktarmamalıdır. Deneme testi ayrı isimle çalışır; npm run check güvenlik regresyonlarını da kapsar.

Şema değişirse npm run generate çalıştırın; üretilen TS/Go dosyalarını elle düzenlemeyin. İlgili kontrolü geçen her tamamlanmış adım anlamlı bir yerel commit alır. Secret/auth, araç cache'i ve ham loglar commit edilmez; kullanıcı istemedikçe push yapılmaz. Yeni bir bulgu, sonuç kapsamıyla birlikte ayrı rapor/ADR'ye yazılır; geçmiş raporların model veya test sonucu değiştirilmez.

Güncel kabul durumu [GO_GATE.md](GO_GATE.md), kanıt dizini [raporlar](../spike/results/README.md), tarihçe [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md).
