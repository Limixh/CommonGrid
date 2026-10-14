# ADR 0023: Sabit yazılım görevini kiralama ve sonuç gönderme

Durum: Uygulandı — açık loopback geliştirme ayarıyla `software-bounds` ve `software-intervals`; dağıtım ve merkezi bağımsız kabul kapsam dışı.

## Karar

Kimlik doğrulamalı koordinatör `CG_EXECUTION_CONTRACTS=software-bounds,software-intervals` ayarıyla yalnız derlenmiş katalogla bütünüyle eşleşen iki sözleşmeye yetenek bildirir. Development, loopback adres, hazır vault ve sabitlenmiş Trivy gerekir. Boş ayar mevcut davranışı korur; bilinmeyen/tekrarlanan kimlik, wildcard ve farklı sözleşme reddedilir. Katalogdaki `execution_capabilities` görev sürümü/hash/base/strateji/süre sınırını taşır; genel `execution_enabled` bütün görevleri açmaz.

Masaüstü, kullanıcının Başlat onayından sonra mevcut oturum ve CSRF ile reserve → start yapar. Sunucu kullanıcıyı oturumdan bulur, kapasite ve süre bütçesini transaction içinde ayırır. İstek anahtarları aynı işlem boyunca değişmez. Native başlangıcı değişmez `lease_context` alır: lease/attempt kimliği, sürüm/hash/base, strateji ve süre sınırı. Cookie, CSRF, hesap kimliği, komut veya sunucu URL'si IPC/worker'a taşınmaz.

İstemci sunucunun kalan süresini istek başlamadan önceki yerel zamana çevirir; yanıt gecikmesi süreyi azaltır, saat farkı ek süre vermez. Native süreyi mevcut 1200 saniye sınırı, lease limiti ve kalan zamanın en küçüğüne indirir. Heartbeat salt durum kontrolüdür; bütçeyi veya süreyi uzatmaz. Uygulama içi sayfa değişimi takibi kesmez. Hesap değişimi özel istemci durumunu siler; native kendi sınırını uygular. Sunucunun sınırlı expiry taraması uygulama kapansa da süresi dolan kiralamayı ve bütçesini serbest bırakır.

Worker bağımsız yerel kontrol ve patch yeniden uygulaması sonrası ADR 0022 paketini gerçek lease kimliğiyle oluşturur. Yalnız `passed` ve doğrulanmış cleanup sonrası native belleğinde en fazla 16384 bayt ZIP tutulur. Public durum baytları içermez. `local_task_run_result_package` yalnız ana yerel webview'den, aynı run kimliği ve tam revision ile okunur; hash/boyut/kanonik base64/lease doğrulanır. İptal, başarısızlık veya belirsiz cleanup paketi kullanılamaz yapar.

Kullanıcı **Gönder** dediğinde aynı-origin web istemcisi paketin hash/boyutunu tekrar denetleyip mevcut tarama/vault upload yoluna, sonra result ucuna gönderir. Yükleme ve gönderimin ayrı değişmez retry anahtarları vardır. Kaybolan upload yanıtı aynı yüklemeyle tekrar edilir; kaybolan result yanıtı aynı onaylanmış gönderimi tekrar ederek makbuzu geri alır. Başarılı gönderim lease'i atomik tamamlar. Başarısız/iptal görevde native cleanup doğrulanmadan end yapılmaz. Native süre sınırından önce tamamlanan sonuç, sunucunun daha uzun teslim süresi dolana kadar gönderilebilir. Paket ve istemci işlemi bellektedir; uygulamayı tamamen yeniden başlatınca yarım gönderim bu panelden sürdürülemez. Sunucuya ulaşmış kayıtlar Katkılarım'da kalır, terk edilmiş lease süresi sonunda serbest bırakılır.

## Kabul sınırı

Makbuz `submitted` durumundadır. Yerel doğrulama ve Trivy geçişi sunucunun görevi bağımsız kabul ettiği anlamına gelmez; iki görev için güvenilir merkezi resolver/harness henüz bağlanmadı. Keyfi repository, görev, komut veya diğer platformlar için çalıştırma açılmaz.

Mevcut destek `npm run desktop` geliştirme akışındaki yapılandırılmış `127.0.0.1:1420` origin'i ve API proxy'sidir. Paketlenmiş custom-origin uygulamanın OAuth dönüşü ve API taşıması ayrı iştir; bu adım IPC izinlerini yabancı web origin'lerine genişletmez. Gerçek sağlayıcı görev kanıtları önceki Haiku/Luna raporlarıdır; bu entegrasyonun testleri ek model çağrısı yapmaz.
