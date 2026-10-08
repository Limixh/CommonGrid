# CLI çalıştırmayı açmadan önce

**Karar: NOT_EVALUATED — uygulamadan görev başlatma kapalı.** Kendi aboneliğiyle resmi CLI tasarımı ve tamamlanmış v1 hedefi korunuyor. Bu liste teknik kabulü takip eder; test raporu tek başına GO vermez.

## Şu an hangi kanıt var?

Windows/Docker üzerinde ayrı görev ve CLI ortamları, araç yönlendirmesi, sentetik saldırılar, kaynak sınırları ve cleanup sınandı. Önceki gerçek hesap görevleri tarihli kanıttır; yeni runtime veya Luna/Haiku kabulünün yerine geçmez. Kaynak teslimi, Trivy ve verifier bağlantısı development düzeyinde çalışıyor; genel Lean/yazılım doğrulayıcısı tamamlanmadı.

## Kalan kısa liste

| İş | Kapanması için gereken kanıt | Durum |
|---|---|---|
| Güncel gerçek görev | Yeni izole resmi oturumla Haiku ve Luna; gerçek dosya değişimi, bağımsız kontrol, cleanup ve API'ye geçiş olmaması | Bekliyor |
| Claude oturum sürekliliği | Doğal zaman geçişi sonrası resmi CLI görevi; yenileme veya yeniden giriş gereksiniminin doğru gözlenmesi; auth dosyası okumadan sonuç kaydı | Bekliyor |
| Kota ve eşzamanlı kullanım | Fixture'da durma/cleanup/no-fallback; normal gerçek kullanımda resmi limit/reset davranışı ve aynı hesap kullanım sınırı gözlemi | Hata yolları fixture ile geçti; gerçek gözlem bekliyor |
| Taşınabilir TLS/izolasyon | Bundled roots varsayılanı; yalnız açık seçilmiş profile ait optional trust; farklı host/provider/tool yollarında auth ve task sınırları | Yerel fixture kabulü; gerçek/platform kabulü bekliyor |
| Kesinti sonrası sahiplik | Gerçek işlem kesintisi, aynı profile yarış, restart ve güvenli cleanup; eski işlem yeni kaynakları silememeli | Sentetik kanıt var; production crash/profile lock kabulü bekliyor |
| Karar ADR'si | CLI sürümü/model/host bazlı kapsam, açık riskler, GO / GO WITH LIMITATION / REWORK / NO-GO ve ilgili kanıtlar | [ADR 0012](../spike/adr/0012-go-gate-priority-and-development-boundaries.md) kabul eksiklerini kaydediyor; GO verilmedi |

Önceki izole gerçek profiller logout durumunda korunuyor. Yeni gerçek kabul, kişinin resmi CLI üzerinden yeni izole girişini gerektirir; host credential dosyaları kopyalanmaz. Bu turda gerçek hesap veya inference kullanılmaz. Kota kasıtlı tüketilmez. Ucuz model yoksa test durur.

Oturumun iki kez açık görünmesi, aradan zaman geçmesi veya Codex refresh isteğinin başarılı dönmesi doğal token yenilemesini kanıtlamaz. Salt okunur quota snapshot da tükenme/reset kabulü veya kullanım izni değildir. Bilgi verilmediğinde unknown kalır.

## Çalışma sırası

1. Oturum/limit hata yollarını sentetik cevaplarla sağlamlaştır; pure yardımcıları ürün paketlerine taşı, deneme runner'larını ayrı tut.
2. Makineye özel TLS davranışını kaldır; default bundled trust ve explicit profile pin kontrollerini doğrula.
3. Hazır izole oturumlarla kısa Haiku/Luna kabulü; ardından doğal süreklilik ve normal kullanım gözlemi.
4. Her ajan/host için karar ADR'sini kanıtlara göre güncelle. Dar bir kabul diğer platformlara veya tüm v1'e yayılmaz.

Bu işler ilerlerken yeni genel altyapı katmanı eklemiyoruz. Küçük bir gerekli düzeltme veya mevcut güvenlik testini destekleyen değişiklik yapılabilir; kalan v1 fazları [yol haritasında](../implementation_roadmap1.3.md) durur.

Test komutları [geliştirme rehberinde](DEVELOPMENT.md), gerçek oturum prosedürü [MANAGED_SESSIONS.md](../spike/cli-session/MANAGED_SESSIONS.md), tarihli kanıtlar [raporlarda](../spike/results/README.md).
