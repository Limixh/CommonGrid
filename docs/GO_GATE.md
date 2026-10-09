# CLI çalıştırmayı açmadan önce

**Karar: NOT_EVALUATED — uygulamadan görev başlatma kapalı.** Kendi aboneliğiyle resmi CLI tasarımı ve tamamlanmış v1 hedefi korunuyor. Bu liste teknik kabulü takip eder; test raporu tek başına GO vermez.

## Şu an hangi kanıt var?

Windows/Docker üzerinde ayrı görev ve CLI ortamları, araç yönlendirmesi, sentetik saldırılar, kaynak sınırları ve cleanup sınandı. Önceki Sonnet/Astra görevleri tarihli kanıttır. 2026-10-09 yerel kabulünde Haiku gerçek görevi, uygulanmış diff, 32 verifier örneği ve cleanup geçti; Luna seçimi doğrulandı fakat aday baseline olarak kaldı ve verifier başarısız oldu. Luna görevinin kök nedeni henüz bilinmiyor. Sonuçlar [güncel kabul kaydında](../spike/results/current-cli-acceptance-windows-2026-10-09.json). Kaynak teslimi, Trivy ve verifier bağlantısı development düzeyinde çalışıyor; genel Lean/yazılım doğrulayıcısı tamamlanmadı.

GitHub Foundations run `37840191064`, commit `7a91deafdd3707cec0fc6e4a380d5b37fd1d0799` için 11 job geçti: Linux CLI/sandbox fixture, artifact, PostgreSQL ve contracts/API/UI; Linux/Windows/macOS native compile ve Temporal fixture/recovery. Sonuçlar [resmi GitHub kanıt kaydında](../spike/results/github-foundations-7a91dea-2026-10-08.json). Bu CI yalnız belirtilen `7a91dea` kaynağını kapsar; sonraki yerel kodu kabul etmiş sayılmaz. Native `--no-bundle` compile, paketlenmiş auth veya dağıtım kabulü değildir; bu koşu gerçek hesap/model, doğal yenileme ve kota kabulünü kapatmaz.

## Kalan kısa liste

| İş | Kapanması için gereken kanıt | Durum |
|---|---|---|
| Güncel gerçek görev | Yeni izole resmi oturumla Haiku ve Luna; gerçek dosya değişimi, bağımsız kontrol, cleanup ve API'ye geçiş olmaması | Haiku geçti; Luna aday/verifier başarısız, tanı bekliyor |
| Claude oturum sürekliliği | Doğal zaman geçişi sonrası resmi CLI görevi; yenileme veya yeniden giriş gereksiniminin doğru gözlenmesi; auth dosyası okumadan sonuç kaydı | Resmi status/restart/status ve checkpoint geçti; doğal yenileme bekliyor |
| Kota ve eşzamanlı kullanım | Fixture'da durma/cleanup/no-fallback; normal gerçek kullanımda resmi limit/reset davranışı ve aynı hesap kullanım sınırı gözlemi | Fixture durma/cleanup geçti; Codex resmi salt okunur snapshot alındı; tükenme/reset/eşzamanlılık bekliyor |
| Taşınabilir TLS/izolasyon | Bundled roots varsayılanı; yalnız açık seçilmiş profile ait optional trust; farklı host/provider/tool yollarında auth ve task sınırları | Haiku görevinde bundled roots ve ek host CA olmadan geçti; diğer host/yollar bekliyor |
| Kesinti sonrası sahiplik | Gerçek işlem kesintisi, aynı profile yarış, restart ve güvenli cleanup; eski işlem yeni kaynakları silememeli | Sentetik kanıt var; production crash/profile lock kabulü bekliyor |
| Karar ADR'si | CLI sürümü/model/host bazlı kapsam, açık riskler, GO / GO WITH LIMITATION / REWORK / NO-GO ve ilgili kanıtlar | [ADR 0012](../spike/adr/0012-go-gate-priority-and-development-boundaries.md) sınırları, [ADR 0013](../spike/adr/0013-current-cheap-model-acceptance.md) güncel kabul sonuçlarını kaydediyor; GO verilmedi |

Önceki Sonnet/Astra profilleri logout durumunda korunuyor. Yeni Haiku/Luna profilleri sonraki normal gözlemler için giriş yapmış halde tutuluyor. Güncel gerçek kabul ayrı geliştirici komutlarıyla, kullanıcının kendi resmi CLI giriş akışı ve yeni izole profiller üzerinden yapılır; host credential dosyaları kopyalanmaz. Sonraki süreklilik gözleminde aynı geçerli profile korunur, gerekmedikçe yeniden login yapılmaz. İşlev testi Codex `gpt-6-luna`, Claude `haiku` kullanır; ucuz model yoksa test durur. Model retry, pahalı/varsayılan model veya ücretli API fallback uygulanmaz; kota kasıtlı tüketilmez. Kabul planı ve sonuç sınırları [ADR 0013](../spike/adr/0013-current-cheap-model-acceptance.md) içindedir; gerçek sonuçlar ayrı tarihli kanıtlarda kaydedilir.

Oturumun iki kez açık görünmesi, aradan zaman geçmesi veya Codex refresh isteğinin başarılı dönmesi doğal token yenilemesini kanıtlamaz. Salt okunur quota snapshot da tükenme/reset kabulü veya kullanım izni değildir. Bilgi verilmediğinde unknown kalır.

## Çalışma sırası

İçerik taşımayan Codex callback tanısı, sabit verifier reddi ve çıktı limiti hata sonucu [yerel kontrolle](../spike/results/cheap-model-foundations-windows-2026-10-09.json) doğrulandı. Bu değişiklikten sonra yeni model çağrısı yapılmadı; geçmiş Luna koşusuna sonuç alanları eklenmedi.

1. Sonraki normal Luna görevinde yeni tanı alanlarıyla araç sonuçlarını değerlendir; değişmiş aday ve bağımsız verifier kabulünü tamamla.
2. Aynı giriş yapmış profillerle doğal süreklilik ve limit davranışını normal kullanımda gözle; gereksiz login/logout veya kota tüketimi yapma.
3. Diğer host/araç yolları ve production kesinti sahipliği kabulünü tamamlayıp her ajan/host için karar ADR'sini güncelle. Dar bir kabul diğer platformlara veya tüm v1'e yayılmaz.

Bu işler ilerlerken yeni genel altyapı katmanı eklemiyoruz. Küçük bir gerekli düzeltme veya mevcut güvenlik testini destekleyen değişiklik yapılabilir; kalan v1 fazları [yol haritasında](../implementation_roadmap1.3.md) durur.

Test komutları [geliştirme rehberinde](DEVELOPMENT.md), gerçek oturum prosedürü [MANAGED_SESSIONS.md](../spike/cli-session/MANAGED_SESSIONS.md), tarihli kanıtlar [raporlarda](../spike/results/README.md).
