# CLI ve görev çalıştırma kabulü

**Genel görev kabulü: NOT_EVALUATED.** Kullanıcıların kendi abonelikleriyle resmi CLI kullanması ve tamamlanmış v1 hedefi korunuyor. Native CLI sürüm kontrolü ayrı ve sınırlı bir kabul adımıdır; başarılı test raporu tek başına tüm görev yollarına GO vermez.

## Güncel kanıt

Profil adı/ajan seçimi ve seçili profil, native uygulama deposunda kalıcıdır. Seçili Codex profili resmi cihaz kodu akışıyla bağlanabilir; hesap kontrolü, çıkış ve iptal aynı paneldedir. Profil seçimi kendi başına hesabın bağlı olduğunu göstermez. Native worker ürün paketindeki resmi oturum modülünü kullanır; geçici cihaz kodu kalıcı metadata veya günlüğe yazılmaz. `App.tsx` katalog, ortam ve katkı ayarları modüllerine ayrıldı. Gerçek hesapla giriş tamamlama, Claude'un etkileşimli giriş bağlantısı ve bağlı profille görev başlatma sıradaki işlerdir.

2026-10-11 Windows/WebView2 koşusunda `npm run test:native-session-smoke` yedi kontrolü geçti: yeni profilde resmi cihaz kodunun arayüze ulaşması, giriş iptali, aynı ortamda hesapsız hesap kontrolü/çıkış ve doğrulanmış cleanup. Model çağrısı veya hesap yetkilendirmesi yapılmadı. Önceki iki giriş denemesi kod üretmeden `session_failed` ile bitti; nedenleri kesinleşmedi ve sonraki başarı geçmiş sonuçları değiştirmez. Panel bu hatayı bağlı hesap olarak göstermiyor; yeniden deneme kullanıcı işlemiyle başlar.

`9d9e7ed` kaynağıyla [Windows uygulamasındaki native CLI sürüm kontrolü](../spike/results/native-cli-launcher-node22-windows-2026-10-11.json) kabul edildi. Gerçek WebView2 koşusunda dokuz kontrol geçti: resmi Codex `0.157.1` ve Claude Code `2.1.293` sürümleri, yinelenen istekler, sürüme bağlı iptal, günlük eşleşmesi ve bağımsız Docker kaynak yokluğu. Koşu Node `22.23.3` ve production frontend kullanan debug uygulamayla yapıldı; hesap/model çağrısı yok. Node `22.23.3` ve `22.14.0` için ayrı ayrı 19 paralel Rust testi geçti. Uzun Windows yolları çalışır; belirsiz yol bileşenleri çalıştırmadan önce reddedilir. Kapsam [ADR 0019](../spike/adr/0019-native-owned-cli-version-check.md) içindedir.

[Aynı kaynağın CI koşusunda](../spike/results/github-foundations-9d9e7ed-2026-10-11.json) 11 iş geçti: Windows/macOS/Linux native testleri ve derlemeleri, 377 Node testi, 40 browser UI testi, Go/şema/tip kontrolleri ve derleme. TypeScript ile Rust 107 ortak günlük örneğinde aynı sonucu verdi. Linux'ta 20 resmi CLI protokol kontrolü ve 54 sentetik Docker grubu cleanup doğrulamasıyla geçti. Browser native mock'ları gerçek Windows koşusundan ayrı kanıttır. Önceki Node yol hatası, disk dolması ve Docker'ın kapalı olduğu koşu kendi başarısız sonuçlarıyla [rapor dizininde](../spike/results/README.md) korunur.

Haiku'nun gerçek görev adayı [34 örneklik yeniden değerlendirmeyi](../spike/results/coding-verifier-sparse-windows-2026-10-09.json), aynı giriş yapmış Codex profiliyle tek yeni Luna görevi [34 örnek, üç başarılı araç çağrısı, uygulanmış patch ve cleanup kontrolünü](../spike/results/managed-task-luna-accepted-windows-2026-10-09.json) geçti. İstenen ve gözlenen ucuz model doğrulandı. Önceki başarısız Luna adayları kendi tarihli raporlarında korunur; bu dar görev kabulü genel yazılım doğruluğu kabulü değildir.

Profil sahipliği, faz günlüğü ve manuel uzlaştırma mevcuttur; native okuyucu ve CLI sürüm kontrolü aynı uygulama deposunu kullanır. Belirsiz mutasyon yeni başlangıcı ve claim bırakılmasını engeller. Günlük süreç kesintisini kapsar; güç/disk/daemon kaybı ve tüm otomatik recovery yolları kabul edilmedi. Ayrıntılar [ADR 0016](../spike/adr/0016-durable-profile-ownership.md), [0017](../spike/adr/0017-operation-phase-journal-and-recovery-review.md) ve [0018](../spike/adr/0018-native-operation-journal-status.md) içindedir.

Aynı Claude profili yaklaşık 11 saat sonra [yeniden giriş olmadan status/restart kontrolünü](../spike/results/managed-session-delayed-claude-windows-2026-10-09.json) geçti. Aradaki kullanım ve token yenilemesi gözlenmedi. Codex'in resmi salt okunur kota snapshot'ı tükenme/reset/eşzamanlı kullanım kabulü değildir; private değerler yayımlanmaz. Bildirilmeyen bilgiler unknown kalır.

## Kalan kısa liste

| İş | Kapanması için gereken kanıt | Durum |
|---|---|---|
| Native CLI sürüm kontrolü | Gerçek uygulamada iki resmi CLI sürümü, istek/iptal sınırları, günlük ve bağımsız cleanup doğrulaması | Windows kabulü tamamlandı; kalıcı profil seçimi ve Codex giriş paneli eklendi; bağlı profille görev kabulü bekliyor |
| Güncel gerçek görev | Geçerli izole resmi profillerle gerçek dosya değişimi, 34 örneklik bağımsız kontrol, cleanup ve API'ye geçiş olmaması | Haiku ve Luna için dar görev kabulü tamamlandı |
| Kalıcı işlem sahipliği | Restart ve host worker ölümü boyunca aynı profile yarışın engellenmesi, eski işlemin yeni kaynakları silememesi | Claim, faz günlüğü, geliştirici/manual uzlaştırma ve native bağlantı geçti; güvenilir görev kabulü, belirsiz mutasyonların güvenli uzlaştırılması ve otomatik recovery bekliyor |
| Claude oturum sürekliliği | Doğal zaman geçişi sonrası resmi CLI görevi; yenileme veya yeniden giriş gereksiniminin auth dosyası okumadan gözlenmesi | Gecikmeli status/restart geçti; doğal yenileme bekliyor |
| Kota ve eşzamanlı hesap kullanımı | Fixture'da durma/cleanup/no-fallback; normal kullanımda resmi limit/reset ve aynı hesap kullanım sınırı gözlemi | Fixture ve salt okunur snapshot var; gerçek tükenme/reset/eşzamanlı hesap kullanımı bekliyor |
| Taşınabilir TLS/izolasyon | Bundled roots varsayılanı, yalnız açık seçilmiş profile ait optional trust; farklı host/provider/tool yollarında auth ve task sınırları | Haiku görevi ek host CA olmadan geçti; diğer host/araç yolları bekliyor |
| Karar ADR'si | CLI sürümü/model/host bazlı kapsam ve GO / GO WITH LIMITATION / REWORK / NO-GO kararı | [ADR 0012](../spike/adr/0012-go-gate-priority-and-development-boundaries.md)–[0019](../spike/adr/0019-native-owned-cli-version-check.md) mevcut kararları kaydeder; GO verilmedi |

Yeni Haiku/Luna profilleri sonraki normal gözlemler için giriş yapmış halde tutuluyor; önceki Sonnet/Astra profilleri logout durumunda korunuyor. Kullanıcının kendi resmi CLI giriş akışı kullanılır; host credential dosyaları kopyalanmaz. İşlev testi Codex `gpt-6-luna`, Claude `haiku` kullanır; ucuz model yoksa test durur. Pahalı/varsayılan modele veya ücretli API'ye fallback yapılmaz; kota kasıtlı tüketilmez. Kabul planı [ADR 0013](../spike/adr/0013-current-cheap-model-acceptance.md) içindedir.

## Çalışma sırası

1. Native sürüm kontrolünün ardından uygulamada görünür tek bir görev akışını tamamla: profil seçimi → resmi CLI girişi/durumu → onaylı görev → Başlat → ilerleme/iptal → doğrulanmış diff. Mevcut yönetilen CLI, görev araçları, işlem sahipliği ve doğrulayıcıyı kullan. İlk akış kabul edilen ajan/platform/görev kapsamında açılır.
2. `App.tsx` ayrıştırması tamamlandı: katalog ve görev detayı `WorkspacePage`/`useTaskCatalog`, ortam ekranı `EnvironmentPage`, katkı ayarları `ContributionSettingsPage` içinde. Yeni giriş/görev panellerini bu modüllere bağla; mevcut arayüz davranışını koru.
3. Akışın kendi kimlik izolasyonu, süre sınırı, iptal ve kaynak sahipliği kontrollerini tamamla. Create cevabının kaybı, daemon kesintisi veya belirsiz cleanup durumunda yeni başlangıcı engelle ve manuel inceleme göster; operatör beyanını otomatik durma kanıtı sayma. Doğal kota tükenmesi, üç platformun tümü ve her otomatik recovery yolu, dar kapsamda kabul edilen herhangi bir görevin başlaması için ortak önkoşul değildir. Oturum/limit davranışını normal kullanımda gözle; diğer ajan/platform ve recovery yollarını ayrıca tamamla. Dar kabul tüm v1'e yayılmaz; genel GO durumu değişmez.

Mevcut yaşam döngüsünü tamamlıyoruz; yeni genel altyapı katmanı eklemiyoruz. Kalan v1 fazları [yol haritasında](../implementation_roadmap1.3.md), test komutları [geliştirme rehberinde](DEVELOPMENT.md), gerçek oturum prosedürü [MANAGED_SESSIONS.md](../spike/cli-session/MANAGED_SESSIONS.md) durur.
