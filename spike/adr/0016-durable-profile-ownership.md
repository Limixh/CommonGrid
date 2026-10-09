# ADR 0016: Kalıcı işlem sahipliği ve profil kilidi

Durum: Geliştirme kararı; ürün GO kapısı kapalı.

## Sorun ve karar

CLI namespace'i kaldırıldığında yalnız bellekte tutulan operation kimliği kayboluyordu. Aynı profili kullanan başka bir komut, status → stop → restart veya public trust manifest'i yazımı sırasında profile erişebiliyordu. Host süreci öldüğünde sonraki süreç de sahipliği güvenilir şekilde bulamıyordu.

Her işlem, profile dokunmadan önce Docker daemon'ında `cg-managed-lease-OWNER` adlı, hiç başlatılmayan bir konteyner oluşturur. Docker'ın benzersiz isim kontrolü eşzamanlı claim'leri dışlar. Değişmez etiketler owner, provider, operation ve kayıt sürümünü bağlar. Kayıt auth/tools hacmi, port veya credential taşımaz; ağsız ve salt okunurdur. Yeniden kullanılabilir claim yardımcıları `packages/agent-adapters` içindedir; geliştirici komutlarının yönetimi `spike/cli-session` içinde kalır.

`stop()` yalnız işlem namespace'lerini temizler. Profil sahipliği restart boyunca tutulur. `finishOperation()` bekleyen mutasyon olmadığı ve namespace cleanup doğrulandığı zaman sahiplik kaydını yakalanmış değişmez Docker ID'siyle en son kaldırır. Prepare, public araç kurulumu, manifest yayımı, görev ve oturum komutları aynı işlem sınırını kullanır. Destroy mevcut başka bir claim'i aşamaz.

Normal restore başka işlemin kaydını sahiplenmez. Yaş, PID veya kaydın `created` olması takeover izni değildir. Açık durmuş-işlem uzlaştırması operation ve lease ID'sini, eski işlemin artık çalışmadığına dair açık operator bilgisini ve bütün namespace'lerin durmuş olduğunu ister. Silmeler isimle değil değişmez ID'yle yapılır; durmuş namespace silmesi force kullanmaz. Namespace yokluğu tek başına gecikmiş Docker create işlemini dışlamadığı için belirsiz durumlar kilitli kalır.

Create çağrısı gönderildikten sonra normal bir nonzero client çıkışı ve başka bir claim görülmesi, ilk çağrının daemon'da tamamlanmadığını kanıtlamaz. Windows'ta kesilmiş client da normal çıkış koduyla bildirilebilir. Bu nedenle belirsizlik yalnız kendi değişmez sahiplik kaydıyla uzlaştırılır; başka claim veya kayıt yokluğu cleanup başarısına çevrilmez. Aynı anda boş profil gören iki contender'dan kaybeden işlem belirsiz kalabilir. Henüz create göndermeden görülen incumbent ise değişiklik yapılmadan reddedilir.

## Kabul ve sınır

[Güncel Windows/Docker kabulü](../results/durable-profile-ownership-windows-2026-10-09.json) `bc45262` kaynağına bağlıdır: 313 Node testi, Go/şema/tip/derlemeleri ve iki sağlayıcıda altışar host owner ölümü, dokuzar süreklilik, on birer saldırı grubu geçti; cleanup doğrulandı. [CLI kaynak hash’leri aynı kalan, arayüz test seçicisi düzeltilmiş kaynağın 11 uzak CI kontrolü](../results/github-foundations-bbcb936-2026-10-09.json) de geçti; süreç fixture'ları üç OS'ta, Docker sahiplik koşuları Linux'ta çalıştı. Eski sahiplik ve süreç raporları kendi kaynak commit'lerine bağlı olarak korunur.

Bu kayıt daemon içinde kalıcı claim sağlar; bütün Docker mutasyonlarına atomik fencing sağlamaz. Otomatik host ölümü tespiti, daemon kaybı sonrası recovery, live takeover, profile garbage collection ve paketlenmiş ürün yaşam döngüsü kabulü tamamlanmadı. Manuel quiescence bilgisi sistemin kendi kanıtı değildir. Gerçek hesap/model, doğal token yenilemesi ve kota davranışı bu sentetik kontrolün kapsamı dışındadır. Uygulama/API çalıştırması `execution_enabled=false`, isolation gate `not_evaluated` kalır.

[GO listesi](../../docs/GO_GATE.md) ve [oturum prosedürü](../cli-session/MANAGED_SESSIONS.md) kalan kabulü takip eder.
