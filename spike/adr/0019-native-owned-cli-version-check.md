# ADR 0019: Masaüstü uygulamasının CLI süreç sahipliği

Durum: Kabul edildi — Windows'ta gerçek native sürüm kontrolü ve cleanup için sınırlı kapsam.

## Karar

Paketlenmiş uygulama, Claude Code ve Codex için ayrı bir sürüm kontrolü başlatır. Arayüz yalnız sağlayıcı ve benzersiz istek kimliği gönderir; komut, dosya yolu, ortam değişkeni, prompt veya model seçemez. Durum ve iptal ayrı native komutlardır. Aynı kimlik/sağlayıcı tekrar gönderilirse mevcut işlem döner; çakışan istek reddedilir. Aynı anda tek kontrol yürütülür.

Yeniden kullanılan Docker yaşam döngüsü `packages/agent-adapters` içindedir. Ürün runtime'ı kaynak ve günlük dizinlerini açık yapılandırmayla alır; repo yolu, deney kanıtı, `.tools` veya test modeli seçimi içermez. `spike` yöneticileri eski kabul komutlarını koruyan ince uyarlayıcılardır.

Build, ESM worker'ı ve build için kullanılan Node 22 binary'sini Tauri kaynaklarına koyar. Public CLI binary'leri mevcut doğrulanmış geliştirme cache'inden hash kontrolüyle alınır; cache yoksa eski build dosyası bırakılmaz. Worker Node'u PATH'ten bulmaz. Node/worker hash manifesti, sabitlenmiş CLI/imaj değerleri ve worker'a gömülen bridge hash'leri çalıştırmadan önce kontrol edilir. Bu build güven sınırıdır; imzalı installer veya bağımsız Node dağıtımı kabulü değildir.

## Süreç ve cleanup

Windows'ta worker boot mesajından önce kill-on-close Job Object'e atanır. POSIX'te ayrı process group kullanılır; native worker'ın Docker istemcileri bu gruptan ayrılmaz. Host süreç ağacının sonlanması Docker kaynaklarının silindiğini kanıtlamaz. İptal önce worker'a gönderilir ve cleanup için ayrı süre ayrılır; zorla sonlandırma veya doğrulanamayan cleanup `needs_review/unknown` kalır.

Windows'ta dosya ve üst dizin denetimleri korunur; Node'a verilen worker argümanının drive/UNC yolu normal mutlak biçime çevrilir. Bu biçimin aynı canonical dosyaya çözüldüğü çalıştırmadan önce doğrulanır; başka dosyaya çözülen veya desteklenmeyen device namespace yolları reddedilir. Sonu ASCII nokta veya boşluk olan yol bileşenleri, UNC server/share adları dahil, uzunluktan bağımsız olarak reddedilir; Rust ve Node'un yol çözümleme farkına güvenilmez. Executable, çalışma dizini ve temiz ortam seçimi değişmez. Bu, Node 22.23.3'ün verbatim worker giriş yolunu açamaması için dar bir uyumluluk düzeltmesidir; uzun yol desteği süreç fixture'ıyla ayrıca sınanır.

Worker'a temiz bir ortam verilir. Provider API anahtarları, host HOME/auth, Node seçenekleri ve Docker context/credential yapılandırması taşınmaz. Docker, hostta kurulu bir ön koşuldur; yalnız mutlak PATH dizinlerinden çözülür. Windows'ta worker yalnız sabit `dockerDesktopLinuxEngine` ve `docker_engine` yerel named pipe'larını süreli, salt okunur sürüm kontrolüyle sınar; Linux/amd64 motoru seçilmeden mutasyon yapılmaz. Seçilen endpoint cleanup boyunca değişmez. Unix yolu varsayılan yerel daemon bağlantısını kullanır; özel/rootless context kabulü ayrı iştir. Her kontrol yeni bir owner ve boş özel hacim oluşturur. Mevcut kullanıcı profilleri restore edilmez. Docker içindeki tek CLI komutu `/opt/cg/<provider> --version` olur; ağsız sandbox model veya hesap çağrısı yapmaz.

Faz kayıtları uygulamanın kendi `managed-operation-journal` dizinine yazılır ve [ADR 0018](0018-native-operation-journal-status.md) okuyucusuyla görülebilir. Başarı, CLI sürümüyle birlikte cleanup'ın doğrulanmasını gerektirir. Provider çıktıları ve ham hata metinleri durum yanıtına taşınmaz.

Sandbox hazırlanmadan önce motor sürümü ve sabitlenmiş imaj sorgulanır. Eksik imaj `image_missing`, erişilemeyen veya uyumsuz motor `docker_unavailable` olur; arayüz kurulum ve bağlantı sorunlarını ayrı açıklar. Bu ön koşul hatalarında Docker kaynağı oluşturulmaz. Runtime imaj kurulumunu kendiliğinden başlatmaz; public kurulum geliştirme rehberinde açık bir adımdır.

## Kabul sınırı ve sonraki iş

Saf fixture'lar, browser native mock'ları, Rust süreç/ACL testleri ve gerçek Windows WebView2 kontrolü ayrı kaydedilir. Gerçek sürüm kontrolü AI üretimi veya abonelikli görev çalıştırma kabulü değildir. Hesap girişini ve seçilen görevi bu başlatıcıya bağlamak; imzalı dağıtım, diğer hostlardaki gerçek süreç davranışı ve belirsiz Docker mutasyonlarını güvenle uzlaştırmak sonraki işlerdir.

Windows kabulünde iki resmi CLI'nin sürümü, aynı istek kimliği, çakışan sağlayıcı reddi, revision'a bağlı iptal, uygulama günlüğünün Node projection'ıyla eşitliği ve bağımsız Docker kaynak yokluğu olmak üzere dokuz kontrol geçti. Model veya hesap çağrısı yapılmadı. Önceki eksik pipe/imaj ve süre sınırı denemeleri başarısız olarak korunur; public imaj kurulumundan sonraki gerçek uygulama koşusu ayrı kabul kanıtıdır.

Komutlar [geliştirme rehberinde](../../docs/DEVELOPMENT.md), sonuçlar [kanıt dizininde](../results/README.md) tutulur.
