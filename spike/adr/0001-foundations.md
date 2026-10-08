# ADR 0001 — İlk uygulama temelleri

Tarih: 2026-10-08 · Durum: Kabul edildi (izolasyon mimarisi kararı hariç)

Koordinatör dili Go olarak seçildi. Uzun süren bağlantı ve kiralama işlemlerinin kaynak maliyetini sınırlamak, HTTP ve eşzamanlılık akışlarını açık biçimde yönetmek amaçlanıyor. İlk HTTP servisi yalnız loopback'te fixture kataloğu sunar; üretim kimlik doğrulaması veya veritabanı yerine kullanılmaz.

Masaüstü Tauri 2 + React + TypeScript'tir. Arayüz Vite geliştirme sunucusundan da kullanılabilir; Rust kabuğunda henüz görev çalıştırma komutu veya shell/fs plugin'i yoktur. Stil ve fontlar yerel paketten gelir.

Görev ailesinin tek kaynağı JSON Schema draft-07'dir. Go ve TypeScript tipleri buradan üretilir, çalışma zamanındaki kontroller ayrıca schema + semantik doğrulama uygular. Draft seçimi iki runtime'da aynı doğrulama için yapıldı; draft-2020-12 özellikleri şimdilik gerekmiyor. Go tip üreticisi mevcut scalar/ref/array/object alt kümesini destekler; yeni desteklenmeyen türde hata vererek durur.

Hash protokolü: `contracts.schema.json` içindeki `TaskContract.properties` alanlarının **contract_hash hariç tümü**, RFC 8785 JCS ile kanonikleştirilir; UTF-8 baytları SHA-256 ile hash edilir ve 64 küçük harf hex olarak yazılır. Liste üretilmiş Go dosyasına da yazılır. Kimlik ve görev sürümü hash'e dahildir. Dizilerin sırası korunur; metinde Unicode normalizasyonu yapılmaz. `execution_context`, gerçek kiralama durumu, aktif paralellik ve ölçülen kullanım bu nesnenin dışında tutulur. Sözleşmedeki onaylı paralellik sınırları, inceleme, ödül ve kaynak limitlerini değiştirmek de yeni sürüm/hash gerektirir.

İstemci ve sunucu aynı golden fixture'ları ve 33 hata/geçerlilik senaryosunu kullanır. Go ham JSON'da yinelenen anahtarları kanonikleştirmeden önce reddeder. İstemcinin JSON.parse sonrasındaki nesne doğrulaması bunu yakalayamaz; sunucu denetimi esas sınırdır. Hash imza veya güvenilir yayımlayıcı kanıtı değildir; OAuth/yetki ve sürüm saklama ayrıca uygulanacaktır.

Yollar göreli POSIX biçiminde, glob'suz açık dosya/dizin listeleridir. Traversal, Windows aygıt adları, sondaki nokta ve `.git/.codex/.claude` alanları reddedilir. Symlink, arşiv ve gerçek dosya izinleri bu metin denetiminden bağımsız güvenlik işleri olarak kalır.

İzolasyon modeli seçilmedi. Credential dosyasını read-only mount etmek çözüm sayılmıyor. Kurulu Codex CLI yalnız `--version`/`exec --help` ile incelendi. Resmi CLI dosya ve komut araçlarını güvenilir kimlik alanından çıkaramadan uygulama çalıştırmaya geçmeyecek. Şimdilik ücretli API modu schema'da kapalı; desteklenecekse ayrı güvenlik/bütçe sözleşmesi gerekir.

Kaynaklar: [Tauri ön koşulları](https://v2.tauri.app/start/prerequisites/), [Vite](https://vite.dev/guide/), [Go JSON Schema doğrulayıcı](https://github.com/santhosh-tekuri/jsonschema), [JCS](https://github.com/cyberphone/json-canonicalization), [Codex headless CLI](https://learn.chatgpt.com/docs/non-interactive-mode). Sağlayıcı koşulları için ürün spec §19 esas alınır ve gerçek spike'ta yeniden kontrol edilir.
