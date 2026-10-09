# CLI çalıştırmayı açmadan önce

**Karar: NOT_EVALUATED — uygulamadan görev başlatma kapalı.** Kullanıcıların kendi abonelikleriyle resmi CLI kullanması ve tamamlanmış v1 hedefi korunuyor. Bu liste teknik kabulü takip eder; başarılı test raporu tek başına GO vermez.

## Güncel kanıt

Haiku'nun gerçek görev adayı [34 örneklik yeniden değerlendirmeyi](../spike/results/coding-verifier-sparse-windows-2026-10-09.json), aynı giriş yapmış Codex profiliyle tek yeni Luna görevi [34 örnek, üç başarılı araç çağrısı, uygulanmış patch ve cleanup kontrolünü](../spike/results/managed-task-luna-accepted-windows-2026-10-09.json) geçti. İstenen ve gözlenen ucuz model doğrulandı. Önceki başarısız Luna adayları kendi tarihli raporlarında korunur; bu dar görev kabulü genel yazılım doğruluğu kabulü değildir.

`bc45262` kaynağıyla [kalıcı profil sahipliği kabulü](../spike/results/durable-profile-ownership-windows-2026-10-09.json) tamamlandı. İki sağlayıcıda altışar gerçek host worker ölümü, dokuzar restart/eşzamanlı sahiplik ve on birer sentetik saldırı grubu geçti; cleanup doğrulandı. Profil claim'i Docker daemon'ında kalır ve stop/restart, public kurulum ve manifest yayımı boyunca tutulur. Yerel genel kontrol 313 Node testi ile Go/şema/tip/derlemeleri geçti. Bu geliştirme yaşam döngüsü kabulüdür; bütün Docker mutasyonlarına atomik fencing veya paketlenmiş ürün recovery'si değildir. Karar ve sınırlar [ADR 0016](../spike/adr/0016-durable-profile-ownership.md) içindedir.

Aynı Claude profili yaklaşık 11 saat sonra [yeniden giriş olmadan status/restart kontrolünü](../spike/results/managed-session-delayed-claude-windows-2026-10-09.json) geçti. Aradaki kullanım ve token yenilemesi gözlenmedi. Codex'in resmi salt okunur kota snapshot'ı tükenme/reset/eşzamanlı kullanım kabulü değildir; private değerler yayımlanmaz. Bildirilmeyen bilgiler unknown kalır.

Önceki [`e909b18` uzak CI kaydı](../spike/results/github-foundations-e909b18-2026-10-09.json) 11 kontrolün başarısını ve üç OS'ta süreç testlerini gösterir; sonraki kaynak değişikliklerini kapsamaz. [Güncel `bbcb936` kaynağı için uzak CI](../spike/results/github-foundations-bbcb936-2026-10-09.json), run `37981596796`, 11 kontrolü geçti: Linux Docker'da sahiplik/kesinti/restart/saldırı koşuları, Windows/macOS/Linux'ta hedefli süreç testleri başarılıdır. İlk CI koşusundaki arayüz seçicisi hatası korunur; düzeltilmiş testle CLI kaynak hash’leri değişmeden bütün kontroller geçti. Bu kapsam gerçek hesap/model veya paketlenmiş ürün recovery kabulü değildir. Tarihli eski model, süreç ve görev sonuçları [rapor dizininde](../spike/results/README.md) korunur.

## Kalan kısa liste

| İş | Kapanması için gereken kanıt | Durum |
|---|---|---|
| Güncel gerçek görev | Geçerli izole resmi profillerle gerçek dosya değişimi, 34 örneklik bağımsız kontrol, cleanup ve API'ye geçiş olmaması | Haiku ve Luna için dar görev kabulü tamamlandı |
| Kalıcı işlem sahipliği | Restart ve host worker ölümü boyunca aynı profile yarışın engellenmesi, eski işlemin yeni kaynakları silememesi | Geliştirici akışında daemon içinde kalıcı claim ve manuel durmuş-işlem uzlaştırması geçti; production faz günlüğü, ürün entegrasyonu ve otomatik recovery bekliyor |
| Claude oturum sürekliliği | Doğal zaman geçişi sonrası resmi CLI görevi; yenileme veya yeniden giriş gereksiniminin auth dosyası okumadan gözlenmesi | Gecikmeli status/restart geçti; doğal yenileme bekliyor |
| Kota ve eşzamanlı hesap kullanımı | Fixture'da durma/cleanup/no-fallback; normal kullanımda resmi limit/reset ve aynı hesap kullanım sınırı gözlemi | Fixture ve salt okunur snapshot var; gerçek tükenme/reset/eşzamanlı hesap kullanımı bekliyor |
| Taşınabilir TLS/izolasyon | Bundled roots varsayılanı, yalnız açık seçilmiş profile ait optional trust; farklı host/provider/tool yollarında auth ve task sınırları | Haiku görevi ek host CA olmadan geçti; diğer host/araç yolları bekliyor |
| Karar ADR'si | CLI sürümü/model/host bazlı kapsam ve GO / GO WITH LIMITATION / REWORK / NO-GO kararı | [ADR 0012](../spike/adr/0012-go-gate-priority-and-development-boundaries.md)–[0016](../spike/adr/0016-durable-profile-ownership.md) mevcut kararları kaydeder; GO verilmedi |

Yeni Haiku/Luna profilleri sonraki normal gözlemler için giriş yapmış halde tutuluyor; önceki Sonnet/Astra profilleri logout durumunda korunuyor. Kullanıcının kendi resmi CLI giriş akışı kullanılır; host credential dosyaları kopyalanmaz. İşlev testi Codex `gpt-6-luna`, Claude `haiku` kullanır; ucuz model yoksa test durur. Pahalı/varsayılan modele veya ücretli API'ye fallback yapılmaz; kota kasıtlı tüketilmez. Kabul planı [ADR 0013](../spike/adr/0013-current-cheap-model-acceptance.md) içindedir.

## Çalışma sırası

1. Mevcut sahiplik sınırına lifecycle faz günlüğünü ve ürün yaşam döngüsünü bağla; host/daemon kesintisi ve belirsiz mutasyonlar için güvenli recovery kabulünü tamamla. Manuel operator bilgisi otomatik quiescence kanıtı sayılmaz.
2. Aynı giriş yapmış profillerle doğal süreklilik ve limit davranışını normal kullanımda gözle; gereksiz login/logout veya kota tüketimi yapma.
3. Diğer host/araç yolları ve production sahiplik kabulünü tamamlayıp her ajan/host için karar ADR'sini güncelle. Dar bir kabul diğer platformlara veya tüm v1'e yayılmaz.

Mevcut yaşam döngüsünü tamamlıyoruz; yeni genel altyapı katmanı eklemiyoruz. Kalan v1 fazları [yol haritasında](../implementation_roadmap1.3.md), test komutları [geliştirme rehberinde](DEVELOPMENT.md), gerçek oturum prosedürü [MANAGED_SESSIONS.md](../spike/cli-session/MANAGED_SESSIONS.md) durur.
