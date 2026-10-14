# ADR 0024: Native yerel çalıştırma sınırları

Durum: Uygulandı — yerel tek deneme sınırı ve kayan 24 saatlik duvar saati bütçesi; CPU/bellek zorlaması, takvim günü ve eşzamanlılık > 1 kapsam dışı.

## Karar

Yerel çalıştırma sınırlarının sahibi native supervisor'dır. Tarayıcıdaki `commongrid.settings.v1` yalnız bir tercih kopyasıdır; fark olduğunda native değer kazanır. Sınırlar iki değerdir: tek deneme üst sınırı (`attempt_sec`) ve kayan 24 saatlik toplam duvar saati bütçesi (`daily_sec`). Varsayılanlar 30 dk ve 120 dk'dır. Sınırlar saniye cinsindendir: her biri en az 60, en çok 86400, `attempt_sec <= daily_sec`. Eşzamanlılık yerelde 1'e sabittir; ayar alanı salt okunur gösterilir. Ücretli API yedeği kapalıdır.

Native, uygulama veri dizininde `run-limits.json` defterini tutar: sınırlar, kapanmış çalıştırmaların kayıtları (`end_ms`, `used_ms`; en çok 256, taşmada en eski ikisi muhafazakâr biçimde birleşir) ve açık rezervasyon (`request_id`, `started_ms`, `reserved_ms`). Dosya en çok 32 KiB'tır, geçici dosya + rename ile atomik yazılır; symlink veya normal olmayan dosya reddedilir. Her çalıştırma başlamadan önce **reserve**, kapanınca **settle** edilir. Reserve ayrılan süreyi deftere yazar; settle kullanılan gerçek duvar saatini (ayrılandan fazla olamaz) yazar. Kapanışı görülmeden kalan (çökme, kill) açık kayıt bir sonraki okumada ayrılan sürenin tamamı kullanılmış sayılarak muhafazakâr biçimde katlanır. 24 saatten eski kayıtlar bütçeden düşer.

Etkin süre sınırı çalıştırma başında native tarafından hesaplanır:

`etkin = min(görev tavanı 1200 sn, lease limiti, attempt_sec, 24 saatte kalan süre)`

Lease yoksa (yerel çalıştırma) lease terimi düşer. Yerel bütçe terimi (`min(attempt_sec, 24 saatte kalan)`) 60 saniyenin altındaysa çalıştırma başlamaz ve `local_budget_exhausted` ile kapanır. Bu alt sınır görev tavanına veya lease'e uygulanmaz: süresi azalmış bir lease kısa ama geçerli bir süre verir. Sınırlar veya defter okunamıyor, bozuk ya da yazılamıyorsa çalıştırma başlamaz ve `local_budget_unavailable` döner (fail closed); sessizce varsayılana dönülmez. Ayarları yeniden kaydetmek açık onarım yoludur: bozuk defterin yerine yalnız yeni sınırları taşıyan temiz defter yazılır ve eski kullanım kaydı düşer. Defter kaydı, worker başlamadan önce başarıyla yazılmalıdır; settle, `Finished` yayımlanmadan önce yapılır. Settle'da kaydedilen süre, ayrılan sürenin üstüne çalıştırmanın gerçekten harcadığı temizlik payını da sayar: üst sınır `reserved + grace (35 sn) + durdurma beklemesi (2 sn)` olur (gerçek geçen süre bu sınırla kısılır); böylece deadline sonrası temizlik bütçeden bedava düşmez. Saat kayması için: `end_ms` değeri `now`'dan ileri olan kayıtlar değerlendirme/budama sırasında `now`'a çekilir ve bu çekme deftere yazılır (ileri saatten kalan kayıt kayma sürdükçe pencerede kalmaz); settle'ın kayıt sonu ve budama ufku, run sırasında saat ileri sıçrasa bile rezervasyon + temizlik payını aşamaz, böylece gerçek geçmiş düşmez. Rezervasyon settle'dan önce paylaşılan durumdan çıkarılır, dosya G/Ç'si kilit tutulmadan yapılır ve sonra `Finished` yayımlanır; settle edilmeden düşen bir rezervasyon kendini düşme anında settle eder. Başlatma kapısının (ADR 0025) reddi kalıcı kilitlenme yaratmaz: yalnız worker kaynaklı `needs_review` yeni başlatmaları yeniden başlatmaya kadar engeller, kapı kararını her başlatmada yeniden verir. Defter yalnız süreç içi kilitle korunur; aynı veri dizinini kullanan ikinci bir uygulama örneğiyle eşgüdüm yoktur (son yazan kazanır, bayat açık kayıt katlaması muhafazakâr kalır).

Durum yüzeyi `local_run_limits_status` (okuma) ve `local_run_limits_save` (tam iki saniye değeri) komutlarıdır; yanıt sınırlar, kullanım (`used_sec`, `open_sec`, `remaining_sec`), etkin üst sınır ve `startable` bilgisini taşır. Arayüz bu değerleri gösterir, Başlat'ı `startable` yanlışken devre dışı bırakır ve çalıştırma bitince yeniden okur; yine de karar native'indir. İstemci doğrulayıcısı native'in hesapladığı değerleri bağımsız olarak yeniden türetir ve uyuşmayan yanıtı geçersiz sayar.

Bu yalnız duvar saati süresidir. Token, abonelik kotası veya para kullanımı değildir ve arayüz bu şekilde adlandırmaz.

## Güven modeli

Sınır, kullanıcının kendi hatasına ve yanlışlıkla fazla harcamaya karşı korur. Tehditler arasında düşman bir webview ya da `run-limits.json` dosyasını silen/düzenleyen kullanıcı yoktur: yerel kullanıcı kendi makinesinde dosyayı silerek bütçeyi sıfırlayabilir ve bu engellenmez. Sunucu tarafı merkezi süre bütçesi ayrı ve bağımsızdır (ADR 0023); iki sınır birlikte uygulanır, biri diğerini genişletmez.

## Ertelenenler

- CPU ve bellek sınırlarının native zorlaması; mevcut CPU/bellek ayarları tercih olarak kalır.
- Sınıra ulaşıldığında kısmi sonuç için checkpoint; süre dolunca görev mevcut `deadline_exceeded` yoluyla kapanır.
- Takvim günü anlamı; pencere kayan 24 saattir.
- Eşzamanlılık > 1.
- Hesap genelindeki sunucu bütçesinin yerel arayüzde gösterilmesi.

## Kabul sınırı

Kanıt birim ve mock testleridir: defter hesabı, reserve/settle, bayat kayıt katlama, bozuk dosya fail-closed, sınır doğrulayıcısı, Tauri komut sözleşmesi ve sahte `__TAURI_INTERNALS__` ile arayüz davranışı (etkin sınır, tükenmiş durum, kaydetme). Bu adım gerçek bir model veya abonelik çağrısı yapmadı; gerçek davranış normal kullanımda gözlenecektir.
