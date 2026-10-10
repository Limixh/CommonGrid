# CommonGrid

Kullanıcıların kendi Claude veya Codex abonelikleriyle ortak matematik ve yazılım problemlerine katkı vereceği masaüstü uygulaması.

Hedefimiz MVP'nin ötesinde tamamlanmış v1: IDE benzeri çalışma alanı, görev paylaşımı, Lean ve yazılım doğrulaması, ara kayıt/devam, inceleme ve topluluk özellikleri. [Ürün kapsamı](PROJECT_SPEC1.2.md) ve [yol haritası](implementation_roadmap1.3.md) bu hedefi tanımlar.

**Geliştirme sürümü.** Görevleri inceleyebilir, katkı tercihlerini ayarlayabilir ve yapılandırılmış sunucuda hesap/katkı kayıtlarını kullanabilirsiniz. Masaüstündeki **Ajanlar ve ortam** ekranında Claude/Codex profil adını ve ajan seçimini kaydedebilir, bir profili seçebilir ve izole CLI sürüm kontrolünü başlatıp iptal edebilirsiniz. Profil kaydı hesap bağlantısından ayrıdır.

## Başlatma

Node.js 22.12+ ve Go 1.26+ gerekir. Windows için isteğe bağlı proje içi Go kurulumu:

```powershell
./scripts/install-go.ps1
npm ci
npm run doctor
npm run dev
```

Arayüz: http://127.0.0.1:1420 · API: http://127.0.0.1:8787/health.

Masaüstü kabuğu için [geliştirme rehberine](docs/DEVELOPMENT.md), hesap kurulumu için [giriş rehberine](docs/AUTHENTICATION.md) bakın.

## Kontroller

```powershell
npm run check
```

Bu komut ürün testlerini, ayrı deneme testlerini, tip kontrollerini ve derlemeyi birlikte çalıştırır. Normal kontrol AI hesabı veya model çağrısı kullanmaz. Veritabanı, tarayıcı, Docker ve gerçek hesap kabulü [test rehberinde](docs/DEVELOPMENT.md) ayrı açıklanır.

## Nerede kaldık?

[Güncel durum ve kabul listesi](docs/GO_GATE.md) tamamlanan işleri ve kalan kanıtları gösterir. Test sayıları README'de tekrarlanmaz; sonuçlar [tarihli raporlarda](spike/results/README.md) tutulur. Önceki geliştirme kayıtları [arşivdedir](docs/DEVELOPMENT_HISTORY.md).

Ürün kodu `apps/`, `packages/` ve `services/` altında; kabul denemeleri `spike/` altındadır. `App.tsx` katalog, ortam ve katkı ayarları modüllerine ayrıldı. Sıradaki iş, kaydedilen profil seçimini resmi CLI girişi, görev başlatma/iptal ve doğrulanmış sonucu görme akışına bağlamak.
