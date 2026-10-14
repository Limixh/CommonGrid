# ADR 0025: Native kalıcı başlatma kapısı

Durum: Uygulandı (birim/mock kanıtı) — görev çalıştırma ve profil oturum işlemleri (giriş, durum, çıkış) başlamadan önce profilin kalıcı işlem günlüğü okunur; çözülmemiş işlem varsa işlem reddedilir. Otomatik kurtarma, sessizlik kanıtı ve uygulama içi temizleme kapsam dışıdır.

## Karar

Önceki `needs_review` engeli yalnız bellekteydi; uygulama yeniden başlayınca kayboluyordu. Native supervisor artık bir görev çalıştırması süre ayırmadan (run-limits reserve) ve worker başlatmadan **önce** seçili profilin kalıcı durumunu okur:

1. Profilin açık oturum bağlaması (`managed-profile-sessions/<profile_id>.json`) okunur.
2. Bağlama `ready` ise o çalışma zamanı sahibine ait kalıcı işlem günlüğü okunur; yalnız `op-{owner}-*` dizinleri dikkate alınır.
3. Bu dizinlerden birinde çözülmemiş işlem varsa çalıştırma, mevcut kapanış yoluyla **bitmiş işlem** olarak reddedilir: `outcome = needs_review`, `error_code = profile_needs_review`, `cleanup = unknown`.

Bağlama geçersizse (`profile_invalid` kapsamında) sonuç `failed` / `profile_invalid`; `reserved` bağlama `profile_needs_review` döner. Aynı kapı ve aynı eşleme profil oturum işlemleri için de geçerlidir (aşağıdaki "Profil oturum işlemleri" bölümü). Yeni IPC komutu veya hata kodu eklenmez; arayüz yalnız metni günceller ve kullanıcıyı **Ajanlar ve ortam → Yerel işlem günlüğü** panelindeki salt okunur kayıtlara yönlendirir.

## Profil oturum işlemleri

Native supervisor giriş, durum ve çıkış işlemlerinde de worker başlatmadan **önce** profilin oturum bağlamasını okur ve aynı eşlemeyi uygular: `reserved` bağlama veya (`ready` bağlama için) o çalışma zamanı sahibinin çözülmemiş ya da geçersiz kalıcı günlüğü işlemi bitmiş `needs_review` / `profile_needs_review` (`session_state = unknown`, `cleanup = unknown`) olarak reddeder; geçersiz bağlama `failed` / `profile_invalid` verir. **Bağlama yoksa işlem sürer**, böylece ilk giriş yapılabilir. Arayüz (`ProfileSessionPanel`) `profile_needs_review` metnini, önceki bir işlemin kapanmadığını belirtip kullanıcıyı Yerel işlem günlüğü paneline yönlendirecek şekilde günceller; reddedilen işlemde giriş kodu alanı gösterilmez ve eylemler kapalı kalır.

## Dar engel koşulu

Çözülmemiş işlem şunlardan biridir: bekleyen niyet (`pending intents`), serbest bırakılmamış edinilmiş lease veya etkin namespace kaydı. Zararsız, terminal olmayan günlükler engellemez: yalnız `begin` yazıp çöken, lease alınmadan reddedilen ve lease bırakıldıktan sonra çöken işlemler. Koşulun dar tutulmasının nedeni kendini sürdüren ret döngüsünden kaçınmaktır: uygulama içinde temizleme yolu olmadığından, zararsız bir yarım kayıt da profili sonsuza dek kilitlerse yalnız elle günlük düzenleyerek çıkılabilirdi. Yalnız kaynak sızdırmış olabilecek durumlar engeller.

## Fail closed

Hiçbir günlük okunamıyor, geçersiz veya şeması bozuksa; dizin adı `op-{owner}-*` biçiminde olup içeriği doğrulanamıyorsa; bağlama dosyası bozuk ya da okunamıyorsa çalıştırma başlamaz. Sessizce "temiz" varsayılmaz. Okuma hatası bağlama bozukluğu olarak `profile_invalid`, günlük bozukluğu olarak `profile_needs_review` ile sonuçlanır.

## Sıralama

Kapı, run-limits reserve'den ve worker oluşturmadan önce çalışır. Reddedilen çalıştırma için deftere süre ayrılmaz; 24 saatlik bütçe etkilenmez (ADR 0024).

## Bu karar ne yapmaz

- Otomatik kurtarma veya kaynak temizliği yapmaz; ADR 0017'deki geliştirici/elle uzlaştırma yolu geçerlidir.
- Önceki worker'ın veya Docker kaynaklarının durduğunu kanıtlamaz. Operatör beyanı sessizlik kanıtı değildir.
- Uygulama içi "temizle / incelendi" eylemi yoktur. Çözüm elle yapılır: salt okunur günlük paneli ve geliştirici kurtarma yolu.
- Aynı veri dizinini kullanan iki uygulama örneğiyle eşgüdüm yoktur; kapı bir anlık okumadır, okuma ile worker başlatma arasındaki yarışı kapatmaz.
- Elektrik kesintisi veya disk hatasıyla yarım kalan yazımların bütünlüğünü kanıtlamaz; yalnız günlüğün okunabilir kısmını değerlendirir.

## Eski günlükler

Kabul edilmiş bir profilin sahibi için daha önce kalmış çözülmemiş günlükler varsa, o profil inceleninceye kadar çalıştırmayı reddeder. Bu beklenen davranıştır; günlük panelinden incelenip geliştirici yoluyla çözülmelidir.

## Kabul sınırı

Kanıt birim ve mock testleridir: bağlama durumları, günlük çözümleme (çözülmemiş ve zararsız terminal olmayan durumlar), geçersiz günlüğün fail closed olması, ret sırasında defter süresi ayrılmaması profil oturum işlemlerinin aynı kapıdan geçmesi (ilk girişin bağlama yokken sürmesi dahil) ve arayüz metinlerinin (TR/EN) mock native durumuyla doğrulanması. Gerçek bir model veya abonelik çağrısı yapılmadı; gerçek yeniden başlatma, güç kaybı ve iki örnek davranışı gözlenmedi.
