# CommonGrid

Kullanıcıların kendi Claude veya Codex abonelikleriyle ortak matematik ve yazılım problemlerine katkı vereceği masaüstü uygulaması.

Hedefimiz MVP'nin ötesinde tamamlanmış v1: IDE benzeri çalışma alanı, görev paylaşımı, Lean ve yazılım doğrulaması, ara kayıt/devam, inceleme ve topluluk özellikleri. [Ürün kapsamı](PROJECT_SPEC1.2.md) ve [yol haritası](implementation_roadmap1.3.md) bu hedefi tanımlar.

**Geliştirme sürümü.** Görevleri inceleyebilir, katkı tercihlerini ayarlayabilir ve yapılandırılmış sunucuda hesap/katkı kayıtlarını kullanabilirsiniz. Masaüstündeki **Ajanlar ve ortam** ekranında Claude/Codex profili oluşturup seçebilir, izole CLI sürümünü kontrol edebilir ve resmi CLI girişini başlatabilirsiniz. Codex cihaz koduyla bağlanır; **Claude hesabını bağla** akışı resmi giriş sayfasını açar ve sayfanın verdiği geçici kodu uygulamadaki maskeli alanda alır. Bu kodu sohbete veya günlüğe yazmayın. Hesap kontrolü, çıkış ve iptal aynı ekrandadır; profil kaydı hesap bağlantısından ayrıdır. **Onaylı görev** paneli, hesabı bağlı profille seçilen yerel görevi onayla başlatır; ilerleme, iptal ve yalnız bağımsız doğrulayıcıdan geçen diff görünür. Bu akış Windows uygulamasında gerçek [Codex/Luna](spike/results/native-task-luna-windows-2026-10-11.json) ve [Claude/Haiku](spike/results/native-task-haiku-windows-2026-10-13.json) hesaplarıyla 34 örneklik kontrollü görev testini geçti. Claude'un uygulama içi resmi girişi de [gerçek hesapla doğrulandı](spike/results/native-session-claude-authenticated-windows-2026-10-13.json). Bu kontrollü görev kabulü Windows ile sınırlıdır; katalog görevlerinin kanıtları aşağıdadır.

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

Çalışma alanındaki **Kontrollü görevi seç** düğmesi yerel `sum.mjs` görevini profil ve onay ekranına taşır. Katalog görevlerinde **Profil seçimini hazırla**, seçilen görev ve yaklaşımı korur; katalogdaki `software-bounds` görevi sabitlenmiş yerel paketle aynı onaylı görev akışına bağlandı ([ADR 0021](spike/adr/0021-catalog-software-task-run.md)) ve Windows'ta gerçek Haiku koşularını geçti (görünür testler + 40/40 gizli durum; [stratejisiz](spike/results/native-task-software-bounds-haiku-windows-2026-10-13.json) ve [seçilen `boundary-first` stratejisiyle](spike/results/native-task-software-bounds-strategy-haiku-windows-2026-10-13.json)) ve Codex/Luna ile [`invariant` stratejili koşuyu](spike/results/native-task-software-bounds-luna-windows-2026-10-13.json) geçti. Seçilen onaylı strateji çalıştırmaya uygulanır; yalnız kimliği gönderilir, talimat doğrulanmış sözleşmeden okunur. İkinci sabit katalog görevi `software-intervals` (`mergeIntervals`: çakışan ve değen kapalı aralıkları birleştirme), Windows'ta [`sort-first` stratejili gerçek Haiku koşusunu](spike/results/native-task-software-intervals-haiku-windows-2026-10-14.json) geçti: görünür testler, 40/40 gizli durum, diff/hash eşleşmesi ve cleanup doğrulandı. Ayrı [`sweep` stratejili Codex/Luna koşusu](spike/results/native-task-software-intervals-luna-windows-2026-10-14.json) aynı dar kabulü geçti. Yazılım sonuç paketi yalnız yerel olarak oluşturulup denetlenir; merkezi lease/gönderim kapalıdır ([ADR 0022](spike/adr/0022-software-result-package.md)).

## Kontroller

```powershell
npm run check
```

Bu komut ürün testlerini, ayrı deneme testlerini, tip kontrollerini ve derlemeyi birlikte çalıştırır. Normal kontrol AI hesabı veya model çağrısı kullanmaz. Veritabanı, tarayıcı, Docker ve gerçek hesap kabulü [test rehberinde](docs/DEVELOPMENT.md) ayrı açıklanır.

## Nerede kaldık?

[Güncel durum ve kabul listesi](docs/GO_GATE.md) tamamlanan işleri ve kalan kanıtları gösterir. Test sayıları README'de tekrarlanmaz; sonuçlar [tarihli raporlarda](spike/results/README.md) tutulur. Önceki geliştirme kayıtları [arşivdedir](docs/DEVELOPMENT_HISTORY.md).

Ürün kodu `apps/`, `packages/` ve `services/` altında; kabul denemeleri `spike/` altındadır. `App.tsx` katalog, ortam ve katkı ayarları modüllerine ayrıldı. Katalog sayfaları, durum filtresi ve görev bağımlılıkları incelenebilir; Katkılarım ekranında deneme, gönderim ve checkpoint ayrıntıları açılır. Uyumlu checkpoint kontrolü salt okunurdur. [Milestone hesaplayıcı](docs/MILESTONE_PROGRESS.md) ve [çevrimdışı simülatör](docs/SIMULATOR.md) ayrı Go paketleridir; canlı orkestratöre entegrasyonları henüz tamamlanmadı. Claude ve Codex için Windows'taki dar giriş/görev kabulü tamamlandı; diğer görev türleri, platformlar ve v1 entegrasyonları sıradaki işlerdir.
