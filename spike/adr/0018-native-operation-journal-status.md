# ADR 0018: Masaüstü uygulamasından işlem günlüğünü okuma

Durum: Windows native okuma ve inceleme kabul edildi; platform ve test sınırları aşağıda tutulur.

## Sorun ve karar

Önceki günlük incelemesi Vite geliştirme sunucusuna bağlıydı. Paketlenmiş masaüstü uygulaması bu endpoint olmadan kendi yerel işlem geçmişini okuyabilmelidir. Tauri içinde tek bir salt okunur `local_operation_status` komutu kullanıyoruz. Komut, uygulamanın yerel veri dizinindeki `managed-operation-journal` alt dizinini okur; istemci bir dosya yolu seçemez. Bu yol Tauri'nin [app local data çözümlemesine](https://docs.rs/tauri/2.12.1/tauri/path/struct.PathResolver.html#method.app_local_data_dir) bağlıdır.

Geliştirici `.local/managed-operation-journal` dizini ayrı kalır. Eski kayıt veya hesap dosyası otomatik taşınmaz. Native işlem başlatıcısı sonraki adımda bu uygulama deposuna yazacaktır; bu değişiklik mevcut geliştirici CLI yöneticisini ürün başlatıcısı olarak sunmaz.

## Sözleşme ve yetki

Native okuyucu, [ADR 0017](0017-operation-phase-journal-and-recovery-review.md) biçimini doğrular ve arayüze yalnız sınırlı `RecoveryStatus` gözlemini döndürür. Auth, argv, prompt, dosya yolları veya ham hata metni taşınmaz. Bozuk bir işlem bütün kataloğu bloke eder; kısmi başarı listesi gösterilmez. Kayıt yaşından veya terminal bayrağından güncel Docker/worker durumu çıkarılmaz.

Rust okuyucu ile TypeScript writer/reader aynı sentetik kayıt kümesine karşı sınanır. Ortak fixture'lar yalnız JSON biçimini değil hash zincirini, canonical byte biçimini, intent/capture/receipt geçişlerini ve bozuk katalogların reddini kapsar. Bu testler ileride iki uygulamanın ayrışmasını yakalamak içindir.

Custom command uygulama manifestinde tanımlanır; yalnız yerel `main` webview için açık okuma izni verilir. Genel filesystem veya shell plugin'i eklenmez. Tauri'nin [capability sınırı](https://v2.tauri.app/security/capabilities/) ve uygulama komutlarının ACL kaydı birlikte kullanılır. Native okuma arka planda yapılır ve eşzamanlı okuyucu sayısı sınırlanır.

Arayüz native bağlantıyı geliştirme modunda da önce seçer. Native hata oluşursa Vite HTTP endpoint'ine geçmez. Browser geliştirme görünümü mevcut endpoint'i kullanır; native bağlantısı olmayan production browser görünümü kullanılamıyor sonucunu verir. Yenileme, timeout ve unmount sonrasında geciken invoke cevabı eski satırları geri getiremez. İnceleme isteği yalnız kimlik ve revision/hash taşır.

## Kabul sınırı

Gerçek WebView2 denemesinde mevcut frontend'in açılmasını engelleyen bir sorun bulundu: Ajv, modül yüklenirken şema için `Function` derlemesi yapıyor ve paketlenmiş uygulamanın CSP'si bunu reddediyordu. Aynı JSON Schema'dan dört standalone doğrulayıcı artık `npm run generate` sırasında üretilir; runtime yalnız bu fonksiyonları ve Ajv'nin küçük yardımcılarını kullanır. Üretim drift kontrolü, eski Ajv ile sonuç/hata eşitliği ve string code generation kapalı bir süreçte mevcut sözleşme testleri korunur. Fontlar same-origin asset olarak paketlenir. CSP'ye `unsafe-eval` veya yeni kaynak izni eklenmez.

Node ortak fixture kontrolleri, Rust okuyucu/IPC testleri, browser transport testleri ve native derleme ayrı kanıttır. Browser IPC mock'u gerçek masaüstü bağlantısı sayılmaz. Windows WebView2 smoke testi ayrıca paketlenmiş asset'lerle, build sırasında yalnız yeni sentetik uygulama dizinine yönlendirilmiş gizli bir pencereyle gerçek native komutu sınar. Bu test kullanıcının varsayılan uygulama dizinine veya resmi CLI hesaplarına erişmez.

Bu adım native okuma ve inceleme bağlantısını tamamlar. Native CLI başlatıcısı, kayıp create cevabını uzlaştırma, daemon/güç kaybı ve otomatik kurtarma ayrı kabul işleridir. Güncel kanıt [GO listesinde](../../docs/GO_GATE.md), test komutları [geliştirme rehberinde](../../docs/DEVELOPMENT.md) tutulur.
