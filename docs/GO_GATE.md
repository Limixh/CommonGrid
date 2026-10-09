# CLI çalıştırmayı açmadan önce

**Karar: NOT_EVALUATED — uygulamadan görev başlatma kapalı.** Kendi aboneliğiyle resmi CLI tasarımı ve tamamlanmış v1 hedefi korunuyor. Bu liste teknik kabulü takip eder; test raporu tek başına GO vermez.

## Şu an hangi kanıt var?

Windows/Docker üzerinde ayrı görev ve CLI ortamları, araç yönlendirmesi, sentetik saldırılar, kaynak sınırları ve cleanup sınandı. Önceki Sonnet/Astra görevleri tarihli kanıttır. 2026-10-09 ilk yerel kabulünde Haiku gerçek görevi, uygulanmış diff, 32 verifier örneği ve cleanup geçti; ilk Luna adayının baseline kaldığı başarısız sonuç [ilk kabul kaydında](../spike/results/current-cli-acceptance-windows-2026-10-09.json) korunuyor.

Aynı Codex profiliyle sonraki tek Luna görevi üç başarılı araç çağrısıyla gerçek dosya ve [patch](../spike/results/managed-task-luna-diagnostics-2026-10-09.patch) üretti; [önceki 32 örneği ve cleanup'ı geçti](../spike/results/managed-task-luna-diagnostics-windows-2026-10-09.json). Boş eleman yuvaları olan dizilerde yanlış hata türü verdiği için bu aday güncel kontrolde reddedildi. Doğrulayıcı artık iki gerçek boş yuvalı diziyle 34 örnek kullanıyor. [AI'sız yeniden değerlendirmede](../spike/results/coding-verifier-sparse-windows-2026-10-09.json) özgün Haiku adayı geçti, Luna reddedildi; 25 sandbox kontrolü ve son cleanup geçti. İlk replay timeout'u başarılı sayılmadı.

Kullanıcının sonraki devam isteğiyle `338c05c` kaynağında aynı Codex profili kullanılarak tek yeni Luna görevi çalıştırıldı. [Güncel 34 örneklik gerçek kabul](../spike/results/managed-task-luna-accepted-windows-2026-10-09.json): istenen ve gözlenen `gpt-6-luna` doğrulandı, üç callback exit=0 ile başarılı döndü, provider turn tamamlandı ve değişmiş aday 32 JSON + iki gerçek boş yuvalı dizi örneğini geçti. [Yeni patch](../spike/results/managed-task-luna-accepted-2026-10-09.patch) gerçekten uygulandı, roundtrip ve cleanup doğrulandı. Yeniden login/logout, credential kopyalama veya fallback yapılmadı. Haiku'nun 34 örneklik replay'i ile Luna'nın bu gerçek görevi dar görev kabulünü tamamlar; önceki başarısız adaylar ve raporlar değişmez.

AI'sız gerçek Docker preflight, yedi araç yönlendirme kontrolüyle dosya değişimi ve 32 örneklik verifier yolunu sınadı; [task yönlendirme kaydı](../spike/results/task-routing-diagnostics-windows-2026-10-09.json) hesap/model kabulü değildir. Kaynak teslimi, Trivy ve verifier bağlantısı development düzeyinde çalışıyor; genel Lean/yazılım doğrulayıcısı tamamlanmadı.

`e909b18` kaynağıyla [gerçek host owner ölümü kontrolü](../spike/results/managed-owner-crash-windows-2026-10-09.json), iki sağlayıcı için beşer sentetik grubu ve cleanup'ı geçti. Host worker SIGKILL sonrası canlı orphan gözlendi; canlı takeover reddi, açık durdurma sonrası exact-operation recovery ve stale cleanup'ın successor'ı koruması doğrulandı. [Yerel genel kontrol](../spike/results/owned-process-foundations-windows-2026-10-09.json) 284 Node testi ve Go/tip/şema/derlemeleri geçti; önceki süreç testinin başarısızlığı unknown cause ile korunur. Bu manuel uzlaştırma kabulüdür; otomatik production recovery veya profile lock kabulü değildir.

[GitHub'ın güncel 11 kontrolü](../spike/results/github-foundations-e909b18-2026-10-09.json), run `37913131506`, `e909b18` kaynağı için geçti. Hedefli süreç testleri Windows/macOS/Linux'ta, owner-crash kontrolü Linux CI'da başarılıdır. Önceki [338c05c CI kaydı](../spike/results/github-foundations-338c05c-2026-10-09.json) ve diğer tarihli kanıtlar kendi kapsamlarıyla korunur. CI yalnız belirtilen commit'i kapsar; gerçek hesap/model, doğal yenileme, kota veya paketlenmiş kullanıcı kurulumu kabulü değildir.

## Kalan kısa liste

| İş | Kapanması için gereken kanıt | Durum |
|---|---|---|
| Güncel gerçek görev | Aynı geçerli izole resmi profillerle gerçek dosya değişimi, güçlendirilmiş 34 örneklik bağımsız kontrol, cleanup ve API'ye geçiş olmaması | Dar görev kabulü tamamlandı: özgün Haiku adayı 34 örneklik replay'i, yeni gerçek Luna görevi değişmiş adayla 34 örneği, patch roundtrip ve cleanup'ı geçti |
| Claude oturum sürekliliği | Doğal zaman geçişi sonrası resmi CLI görevi; yenileme veya yeniden giriş gereksiniminin doğru gözlenmesi; auth dosyası okumadan sonuç kaydı | Yaklaşık 11 saat 5 dakika sonra resumed status/restart/status ve cleanup geçti; aradaki kullanım gözlenmedi, doğal yenileme bekliyor |
| Kota ve eşzamanlı kullanım | Fixture'da durma/cleanup/no-fallback; normal gerçek kullanımda resmi limit/reset davranışı ve aynı hesap kullanım sınırı gözlemi | Fixture durma/cleanup geçti; Codex resmi salt okunur snapshot alındı; tükenme/reset/eşzamanlılık bekliyor |
| Taşınabilir TLS/izolasyon | Bundled roots varsayılanı; yalnız açık seçilmiş profile ait optional trust; farklı host/provider/tool yollarında auth ve task sınırları | Haiku görevinde bundled roots ve ek host CA olmadan geçti; diğer host/yollar bekliyor |
| Kesinti sonrası sahiplik | Gerçek işlem kesintisi, aynı profile yarış, restart ve güvenli cleanup; eski işlem yeni kaynakları silememeli | Gerçek host worker ölümüyle iki sağlayıcıda beşer sentetik grup ve açık recovery/cleanup geçti; kalıcı operation journal, exclusive production profile ownership ve otomatik recovery bekliyor |
| Karar ADR'si | CLI sürümü/model/host bazlı kapsam, açık riskler, GO / GO WITH LIMITATION / REWORK / NO-GO ve ilgili kanıtlar | [ADR 0012](../spike/adr/0012-go-gate-priority-and-development-boundaries.md) sınırları, [ADR 0013](../spike/adr/0013-current-cheap-model-acceptance.md) ilk kabulü, [ADR 0014](../spike/adr/0014-task-routing-and-sparse-verifier.md) güçlü görev kontrolünü, [ADR 0015](../spike/adr/0015-host-owner-crash-and-process-cleanup.md) host owner ölümü ve launcher cleanup sınırını kaydediyor; GO verilmedi |

Önceki Sonnet/Astra profilleri logout durumunda korunuyor. Yeni Haiku/Luna profilleri sonraki normal gözlemler için giriş yapmış halde tutuluyor. Güncel gerçek kabul ayrı geliştirici komutlarıyla, kullanıcının kendi resmi CLI giriş akışı ve yeni izole profiller üzerinden yapılır; host credential dosyaları kopyalanmaz. Sonraki süreklilik gözleminde aynı geçerli profile korunur, gerekmedikçe yeniden login yapılmaz. İşlev testi Codex `gpt-6-luna`, Claude `haiku` kullanır; ucuz model yoksa test durur. Model retry, pahalı/varsayılan model veya ücretli API fallback uygulanmaz; kota kasıtlı tüketilmez. Kabul planı ve sonuç sınırları [ADR 0013](../spike/adr/0013-current-cheap-model-acceptance.md) içindedir; gerçek sonuçlar ayrı tarihli kanıtlarda kaydedilir.

[Gecikmeli Claude kontrolü](../spike/results/managed-session-delayed-claude-windows-2026-10-09.json) aynı profilin yaklaşık 11 saat sonra açık olduğunu gösterir; aradaki kullanım veya token yenilemesi gözlenmedi. Resmi kota snapshot'ı tükenme/reset kabulü veya kullanım izni değildir; değerler private kalır. Bildirilmeyen bilgiler unknown kalır.

## Çalışma sırası

İçerik taşımayan Codex callback tanısı, sabit verifier reddi ve çıktı limiti hata sonucu [yerel kontrolle](../spike/results/cheap-model-foundations-windows-2026-10-09.json) doğrulandı. Sonraki araç yönergeleri `f09a592` ile açıklaştırıldı: doğrudan argv, Node kullanılabilirliği, örtük shell/stdin olmaması ve varsayılan 3 saniye timeout. Yeni tarihli Luna koşusu bu tanı alanlarıyla ayrı kaydedilir; ilk başarısız Luna raporuna geriye dönük sonuç eklenmez.

1. Mevcut runtime'ın operation kimliğini kalıcılaştır ve exclusive profile ownership'i üretim akışına bağla; restart/kesinti sonrası aynı sahiplik sınırının korunduğunu doğrula. Yeni genel altyapı yerine mevcut yaşam döngüsünü tamamla.
2. Aynı giriş yapmış profillerle doğal süreklilik ve limit davranışını normal kullanımda gözle; gereksiz login/logout veya kota tüketimi yapma.
3. Diğer host/araç yolları ve production kesinti sahipliği kabulünü tamamlayıp her ajan/host için karar ADR'sini güncelle. Dar bir kabul diğer platformlara veya tüm v1'e yayılmaz.

Bu işler ilerlerken yeni genel altyapı katmanı eklemiyoruz. Küçük bir gerekli düzeltme veya mevcut güvenlik testini destekleyen değişiklik yapılabilir; kalan v1 fazları [yol haritasında](../implementation_roadmap1.3.md) durur.

Test komutları [geliştirme rehberinde](DEVELOPMENT.md), gerçek oturum prosedürü [MANAGED_SESSIONS.md](../spike/cli-session/MANAGED_SESSIONS.md), tarihli kanıtlar [raporlarda](../spike/results/README.md).
