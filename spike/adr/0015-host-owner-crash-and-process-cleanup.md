# ADR 0015 — Host owner ölümü ve süreç temizliği

Tarih: 2026-10-09. Durum: `e909b18b772b7b4eac98bcd5fb54d08ac0c5c05d` kaynağıyla kontrollü host owner ölümü ve açık uzlaştırma kabulü geçti. Production operation journal, profile lock ve otomatik crash recovery bekler. GO verilmedi; `execution_enabled=false`, `isolation_gate=not_evaluated`.

## Problem ve dar kabul

Host Node owner'ının ölmesi Docker namespace'ini ve alt süreçlerini kendiliğinden sonlandırmaz. Yeni operation canlı orphan'ı devralmamalı; eski operation cleanup'ı successor'ın kaynaklarını silememeli.

[Gerçek Docker kontrolü](../results/managed-owner-crash-windows-2026-10-09.json) Windows host/Linux runtime üzerinde iki sağlayıcı için beşer grubu ve son cleanup'ı geçti. Yeni sentetik profiller ve sahte kalıcı durum kullanıldı. Worker başlatma öncesinde yalnız profil ve işlem kimliğini bildirdi; hazır mesajıyla konteynerin değişmez kimliği alınıp doğrulandı. Sınırlı sürede gerçek SIGKILL sonrası namespace ve descendant'ın canlı kaldığı gözlendi; yeni operation start, recovery ve cleanup canlı orphan'ı korudu. Namespace açıkça durduruldu; yanlış operation reddedildi, exact stopped operation uzlaştırıldı ve hacimler korundu. Successor yeniden çalışırken eski cleanup ona dokunmadı. Descendant gecikmiş yazı timer'ını kurduğunu bildirdikten sonra namespace durduruldu; beklenen yazının oluşmadığı ayrıca kontrol edildi.

Bu sonuç açık, sahipliği doğrulanmış manuel recovery içindir. Önceki giriş yapmış profillere erişilmedi; gerçek credential, hesap, API veya CLI inference kullanılmadı. İlk owner-crash fixture koşusu da geçti; public kayıt son kaynakla tekrar edilen koşuya bağlıdır.

## Windows launcher sonucunun gözlenmesi

`CommandError.cleanup`, command timeout/iptal/çıktı sınırı reddinden ayrı bir Promise ile en fazla 5 saniyelik launcher temizliği sonucunu bildirir. Windows'ta taskkill helper'ın exit=0 sonucu ve owned root exit birlikte gözlendiğinde `termination_reported` döner; hata veya deadline `unconfirmed` kalır. Command reddi bu Promise'i beklemez. Bu sonuç bütün descendant'ların yokluğunu kanıtlamaz; gerçek descendant ve namespace kontrolleri ayrı tutulur.

[Yerel genel kontrol](../results/owned-process-foundations-windows-2026-10-09.json) 284 Node testi, sıfır failure/skip, Go testleri, şema/tip kontrolleri ve derlemeleri geçti. Windows'taki iki hedefli süreç testi helper/root sonucunu, descendant ölümünü ve fixture teardown'ını ayrı gözledi. Önceki genel kontroldeki “owned child must no longer be running” başarısızlığı aynı kayıtta false ve unknown cause olarak korunur. Completion observability düzeltmesi bu başarısızlığın veya eski Docker timeout'larının kök nedenini kanıtlamaz; geçmiş sonuç başarıya çevrilmez.

Owner-crash kontrolü mevcut Linux CLI fixture CI işine, hedefli süreç kontrolleri mevcut Windows/macOS/Linux compile işlerine bağlandı. [Ayrı uzak kabul kaydı](../results/github-foundations-e909b18-2026-10-09.json), `e909b18` için 11 işin geçtiğini; hedefli süreç testlerinin üç OS'ta ve owner-crash komutunun Linux CI'da başarılı olduğunu doğrular. Yerel genel kontrol kaydındaki CI `pending` alanı o kayıt anını gösterir. Bu uzak kontroller tam CLI/auth/araç taşınabilirliği veya production sahipliği kabulü değildir.

## Kalan sınır ve sonraki adım

Kontrol, hazır namespace'in dedicated host worker'ının zorla öldürülmesini kapsar. Host/daemon crash, lost-create-ID, kalıcı operation journal, exclusive production profile ownership ve otomatik live takeover/recovery kabulü değildir. Sıradaki iş mevcut runtime'ın operation kimliğini kalıcılaştırmak ve exclusive profile ownership'i üretim akışına bağlamaktır; yeni genel altyapı katmanı eklemek değildir. [GO listesi](../../docs/GO_GATE.md) ve [oturum prosedürü](../cli-session/MANAGED_SESSIONS.md) bu sınırı korur.
