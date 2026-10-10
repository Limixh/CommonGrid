# CLI çalıştırmayı açmadan önce

**Karar: NOT_EVALUATED — uygulamadan görev başlatma kapalı.** Kullanıcıların kendi abonelikleriyle resmi CLI kullanması ve tamamlanmış v1 hedefi korunuyor. Bu liste teknik kabulü takip eder; başarılı test raporu tek başına GO vermez.

## Güncel kanıt

`bed8be2` kaynağıyla [paketlenmiş Windows uygulamasından günlük okuma ve inceleme](../spike/results/native-operation-status-windows-2026-10-10.json) kabul edildi. Değişmeyen Node/Go/frontend kaynağında 357 Node testi, genel Go/şema/tip/derleme kontrolü ve 24 browser UI testi; native context düzeltmesinden sonra 7 Rust testi ve gerçek WebView2 uygulamasında beş kontrol geçti. TypeScript ile Rust 107 ortak örnekte aynı sonucu verdi. Native kontroller; kayıt yokluğu, tam IPC eşleşmesi, sürüme bağlı inceleme isteği, istemcinin dosya yolu seçmesinin reddi ve bozuk kataloğun gizlenmesini kapsar. Browser native mock'ları ayrı kanıttır. Yeni sentetik uygulama dizini kullanıldı; gerçek hesap/model çağrısı yapılmadı.

Bu denemede bulunan masaüstü açılış hatası, aynı şemadan build sırasında üretilen standalone doğrulayıcılarla düzeltildi; CSP değişmedi. İlk başarısız uygulama koşusu ve sonraki smoke testindeki yanlış native-marker simülasyonu raporda ayrı korunur. Native okuyucu artık bağlıdır; gerçek CLI görevlerini bu uygulama deposuna yazacak native başlatıcı sonraki adımdır. Geliştirici ve native günlük dizinleri otomatik taşınmaz. Sınırlar [ADR 0018](../spike/adr/0018-native-operation-journal-status.md) içindedir.

Haiku'nun gerçek görev adayı [34 örneklik yeniden değerlendirmeyi](../spike/results/coding-verifier-sparse-windows-2026-10-09.json), aynı giriş yapmış Codex profiliyle tek yeni Luna görevi [34 örnek, üç başarılı araç çağrısı, uygulanmış patch ve cleanup kontrolünü](../spike/results/managed-task-luna-accepted-windows-2026-10-09.json) geçti. İstenen ve gözlenen ucuz model doğrulandı. Önceki başarısız Luna adayları kendi tarihli raporlarında korunur; bu dar görev kabulü genel yazılım doğruluğu kabulü değildir.

[İşlem faz günlüğü ve geliştirici kurtarma kabulü](../spike/results/operation-phase-journal-windows-2026-10-10.json), host worker ölümü sonrasında geçmişi korur. Docker mutasyonundan önce intent, dönen değişmez ID için capture ve doğrulama sonrası receipt yazılır; belirsiz kayıt sonraki mutasyonları ve claim release'i engeller. Manuel durmuş-işlem uzlaştırması eski kimliğe ve lease ID'sine ait doğrulanmış, pending kaydı olmayan günlük ister. Ayrıntılar [ADR 0017](../spike/adr/0017-operation-phase-journal-and-recovery-review.md) içindedir.

Profil claim'i Docker daemon'ında kalır ve stop/restart, public kurulum ve manifest yayımı boyunca tutulur. [Önceki sahiplik kabulü](../spike/results/durable-profile-ownership-windows-2026-10-09.json) ve [ADR 0016](../spike/adr/0016-durable-profile-ownership.md) bu sınırı açıklar. Yeni günlük Windows'ta süreç kesintisini kapsar; güç, disk veya daemon kaybını kapsamaz. Geliştirici ve native inceleme görev başlatma veya cleanup yetkisi taşımaz. Native görev başlatıcısı ve otomatik recovery ayrı kabul işleridir.

Aynı Claude profili yaklaşık 11 saat sonra [yeniden giriş olmadan status/restart kontrolünü](../spike/results/managed-session-delayed-claude-windows-2026-10-09.json) geçti. Aradaki kullanım ve token yenilemesi gözlenmedi. Codex'in resmi salt okunur kota snapshot'ı tükenme/reset/eşzamanlı kullanım kabulü değildir; private değerler yayımlanmaz. Bildirilmeyen bilgiler unknown kalır.

[Güncel `bed8be2` uzak CI kaydı](../spike/results/github-foundations-bed8be2-2026-10-10.json), run `38047041303`, 11 başarılı işi gösterir. Windows/macOS/Linux'ta gerçek generated ACL ile mock runtime testleri, 107 ortak günlük örneği, süreç fixture'ları ve native derleme geçti; gerçek WebView2 kabulü Windows raporunda ayrı tutulur. Linux'ta 20 resmi CLI protokol kontrolü ve 54 sentetik Docker grubu geçti, cleanup doğrulandı. [İlk `19623f5` koşusunda](../spike/results/github-foundations-19623f5-failed-2026-10-10.json) 10 iş geçti; macOS test derlemesi yinelenen plist sembolü yüzünden başarısız oldu. Tek context genişlemesiyle düzeltildi ve yeni kaynakla tüm işler geçti. İlk hata ve daha önceki model/süreç sonuçları [rapor dizininde](../spike/results/README.md) korunur.

## Kalan kısa liste

| İş | Kapanması için gereken kanıt | Durum |
|---|---|---|
| Güncel gerçek görev | Geçerli izole resmi profillerle gerçek dosya değişimi, 34 örneklik bağımsız kontrol, cleanup ve API'ye geçiş olmaması | Haiku ve Luna için dar görev kabulü tamamlandı |
| Kalıcı işlem sahipliği | Restart ve host worker ölümü boyunca aynı profile yarışın engellenmesi, eski işlemin yeni kaynakları silememesi | Claim, faz günlüğü, geliştirici/manual uzlaştırma ve native okuma bağlantısı geçti; native görev başlatıcısı, belirsiz mutasyonların güvenli uzlaştırılması ve otomatik recovery bekliyor |
| Claude oturum sürekliliği | Doğal zaman geçişi sonrası resmi CLI görevi; yenileme veya yeniden giriş gereksiniminin auth dosyası okumadan gözlenmesi | Gecikmeli status/restart geçti; doğal yenileme bekliyor |
| Kota ve eşzamanlı hesap kullanımı | Fixture'da durma/cleanup/no-fallback; normal kullanımda resmi limit/reset ve aynı hesap kullanım sınırı gözlemi | Fixture ve salt okunur snapshot var; gerçek tükenme/reset/eşzamanlı hesap kullanımı bekliyor |
| Taşınabilir TLS/izolasyon | Bundled roots varsayılanı, yalnız açık seçilmiş profile ait optional trust; farklı host/provider/tool yollarında auth ve task sınırları | Haiku görevi ek host CA olmadan geçti; diğer host/araç yolları bekliyor |
| Karar ADR'si | CLI sürümü/model/host bazlı kapsam ve GO / GO WITH LIMITATION / REWORK / NO-GO kararı | [ADR 0012](../spike/adr/0012-go-gate-priority-and-development-boundaries.md)–[0018](../spike/adr/0018-native-operation-journal-status.md) mevcut kararları kaydeder; GO verilmedi |

Yeni Haiku/Luna profilleri sonraki normal gözlemler için giriş yapmış halde tutuluyor; önceki Sonnet/Astra profilleri logout durumunda korunuyor. Kullanıcının kendi resmi CLI giriş akışı kullanılır; host credential dosyaları kopyalanmaz. İşlev testi Codex `gpt-6-luna`, Claude `haiku` kullanır; ucuz model yoksa test durur. Pahalı/varsayılan modele veya ücretli API'ye fallback yapılmaz; kota kasıtlı tüketilmez. Kabul planı [ADR 0013](../spike/adr/0013-current-cheap-model-acceptance.md) içindedir.

## Çalışma sırası

1. Kabul edilen native okuma bağlantısının ardından CLI başlatıcısını uygulama deposuna ve ürün yaşam döngüsüne bağla. Create cevabının kaybı, daemon kesintisi ve belirsiz mutasyonlar için güvenli recovery kanıtını tamamla. Manuel operator bilgisi otomatik quiescence kanıtı sayılmaz. Önceki CI native exec hatasının nedeni bilinmiyor; tekrarlanırsa ilgili kontrol ve sınırlı tanı kanıtı ayrıca kaydedilir.
2. Aynı giriş yapmış profillerle doğal süreklilik ve limit davranışını normal kullanımda gözle; gereksiz login/logout veya kota tüketimi yapma.
3. Diğer host/araç yolları ve production sahiplik kabulünü tamamlayıp her ajan/host için karar ADR'sini güncelle. Dar bir kabul diğer platformlara veya tüm v1'e yayılmaz.

Mevcut yaşam döngüsünü tamamlıyoruz; yeni genel altyapı katmanı eklemiyoruz. Kalan v1 fazları [yol haritasında](../implementation_roadmap1.3.md), test komutları [geliştirme rehberinde](DEVELOPMENT.md), gerçek oturum prosedürü [MANAGED_SESSIONS.md](../spike/cli-session/MANAGED_SESSIONS.md) durur.
