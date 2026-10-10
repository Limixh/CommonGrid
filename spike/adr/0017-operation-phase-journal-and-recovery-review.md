# ADR 0017: İşlem faz günlüğü ve kurtarma incelemesi

Durum: Geliştirme kararı; ürün GO kapısı kapalı.

## Sorun ve karar

Docker içindeki kalıcı profil claim'i eşzamanlı işlemleri dışlar, fakat host süreç kesildiğinde hangi mutasyonun yarım kaldığını tek başına anlatmaz. Her yeni yönetilen işlem için auth verisinden ayrı, yerel bir faz günlüğü oluşturuyoruz. Yeniden kullanılabilir kayıt ve inceleme kodu `packages/agent-adapters` içindedir; geliştirici Docker yöneticisi `spike/cli-session` içinde kalır.

İşlem bir mutasyon göndermeden önce sınırlı ve tipli bir intent yazar. Create cevabındaki değişmez ID ayrıca yakalanır; bu kayıt intent'i başarılı saymaz. Sahiplik veya cleanup kanıtı doğrulandığında receipt yazılır. Receipt'i eksik intent belirsiz kalır. Normal restore yeni operation üretir; eski günlük sahiplenme, otomatik tekrar gönderme veya takeover izni vermez.

Kayıtlar sıralı, değişmez, hash zincirli ve boyut/sayı sınırlıdır. Sonraki kayıt mevcut hedefin üzerine yazılmadan yayımlanır. Yazma veya durability hatası writer'ı kapatır; sonraki mutasyonlar bu hata aşılmadan gönderilmez. Sıra boşluğu, bozuk içerik, yabancı alan, aşırı büyük kayıt veya symlink üzerinden gelen kayıtlar incelemeyi bloke eder. Ayrı bir kalıcı head anchor bulunmadığı için son kayıtların bütünüyle silinmesi, daha kısa fakat geçerli bir zincir olarak okunabilir. Hash'ler kalan kayıtların içerik/sıra tutarlılığını sınar; yerel saldırgana karşı imza veya rollback tespiti yerine geçmez. Yerel dizin uygulamanın kontrolünde olmalıdır; path kontrolleri kötü niyetli yerel değiştirmeye karşı native filesystem confinement sağlamaz.

Günlük yalnız owner/provider/operation kimliklerini, sabit action/role değerlerini, sıra/hash değerlerini ve değişmez kaynak ID'lerini taşır. Argüman, prompt, credential, PEM, dosya yolu, Docker environment, stdout/stderr veya serbest hata metni kaydedilmez. `.local/managed-operation-journal` geliştirme akışının sabit yerel dizinidir; Git'e veya uzak koordinatöre gönderilmez.

## Disk ve kurtarma sınırı

Dosya içeriği yayımlanmadan önce sync edilir. Linux'ta dizin de sync edilir. Windows'ta Node dosya sync'i ve hard-link yayımı yalnız host süreç kesintisine karşı bu uygulamanın kabul kapsamındadır; güç kaybı veya disk/daemon kaybı kalıcılığı kanıtlanmış sayılmaz. Okunan durability değeri mevcut Docker durumu veya owner'ın artık çalışmadığına dair kanıt değildir.

Günlükte terminal kayıt bulunması yalnız geçmişte kaydedilmiş tamamlanmayı gösterir. Yaş, PID, tek bir yokluk listesi, hash veya terminal bayrağı canlı owner'ın durduğunu kanıtlamaz. Belirsiz mutasyonlar varken claim release başarılı sayılamaz. [ADR 0016](0016-durable-profile-ownership.md) içindeki değişmez-ID fencing ve release-last sınırı devam eder.

Uygulamanın geliştirme arayüzü salt okunur yerel inceleme sunar. İnceleme isteği tam operation kimliğine ve günlük revision/hash'ine bağlanır; cleanup, takeover veya görev başlatma yetkisi taşımaz. Endpoint yalnız sabit yerel dizini okur, istemci tarafından dosya yolu kabul etmez. Eksik veya bozuk kayıt temiz ortam sonucuna çevrilmez.

Paketlenmiş Tauri uygulamasında yerel görev başlatıcısı ve native journal köprüsü henüz yoktur. Geliştirici görünümü bu entegrasyonun kabulü değildir. Mevcut açık `recoverStopped` yardımcısı operator quiescence bilgisi, tam eski receipt ve aynı kimliğe/lease ID'sine ait doğrulanmış, pending kaydı olmayan nonterminal günlük ister. Eksik/bozuk günlük veya belirsiz mutasyon operator onayıyla aşılamaz. Günlükte yakalanmış bütün mevcut ID'ler önce durmuş ve aynı işleme ait olarak doğrulanır; kayıtsız namespace karşısında silme başlamaz. Bu ayrı geliştirici yolu otomatik recovery veya eski günlüğün kapanması olarak sunulmaz. Private hacim tutulur, durmuş namespace silmesi force kullanmaz.

## Kabul

Kayıt, yayınlama hatası, çakışan writer, bozulma, sınır ve gizlilik fixture'ları; runtime dispatch öncesi yazma ve belirsizlik testleri; salt okunur endpoint ve arayüz akışı bu değişikliğin kabulünü oluşturur. Gerçek Docker testi yalnız yeni sentetik profillerde host worker ölümü sonrası günlüğü yeniden okur. Hesap/model, doğal token yenilemesi, kota tükenmesi veya paketlenmiş ürün kurtarması bu kabulün kapsamı dışındadır.

Güncel kanıt ve kalan işler [GO listesinde](../../docs/GO_GATE.md) tutulur. `execution_enabled=false`, automatic recovery kapalı ve isolation gate `not_evaluated` kalır.
