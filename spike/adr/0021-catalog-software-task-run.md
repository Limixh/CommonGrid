# ADR 0021: Katalog yazılım görevinin onaylı çalıştırılması

Durum: Uygulanıyor — sözleşme, sabit paket ve mock/fixture testleriyle; gerçek hesap/Windows kabulü yapılmadı.

## Karar

ADR 0020'deki onaylı görev akışı ikinci bir sabit görevi çalıştırır: katalogdaki `software-bounds` (`lowerBound` sınır koşulları). Arayüz yine yalnız istek kimliği, profil kimliği, sabit görev kimliği ve `approved: true` gönderir; izinli kimlikler `controlled-sum-integers-v1` ve `software-bounds`'tur. Yeni genel altyapı katmanı yoktur: kontrollü görevin sandbox, köprü, işlem claim'i, cleanup ve sonuç kuralları aynen kullanılır; worker yalnız iki girişli düz bir tabloyla görev başına tohumlama, prompt, aday dışa aktarma, doğrulayıcı ve diff adımlarını seçer.

**Sabitlenmiş yerel paket.** Görev dosyaları `packages/agent-adapters/task-assets/software-bounds` altındadır: `package.json`, hatalı başlangıç `src/search.ts` ve görünür testler `tests/search.test.ts`. `npm run generate` bunları içerik, dosya başına sha256 ve deterministik sentetik git blob/tree/commit kimlikleriyle `software-bounds-bundle.generated.ts` dosyasına yazar; `npm run generate:check` kaymayı yakalar. Katalog sözleşmesindeki `workspace.commit` bu sentetik commit'tir. `workspace.repo` yalnız şemanın zorunlu kıldığı yer tutucu URL'dir: hiçbir şey klonlanmaz veya indirilmez ve commit gerçek bir depoya ait değildir. İmaj, runtime'ın sabit taban imajıdır (`node@sha256:…`); sözleşme 1 CPU, 256 MB ve 1200 sn ile bağlıdır.

**Sözleşme bağlama.** Runner, `taskRunCatalogPins` ile görev kimliği, sürümü ve `contract_hash` değerini sabitler. Worker, Docker'a dokunmadan önce `verifySoftwareBundle` çalıştırır: şema ve hash, paket dosya hash'leri, git kimliklerinin yeniden hesabı ile `workspace.commit` eşitliği, giriş dosyaları, tek yazılabilir yol, `forbidden_patterns`, imaj, kaynak sınırları ve test komutu. Herhangi bir uyuşmazlık `asset_invalid` olur ve hiçbir Docker çağrısı yapılmaz.

**Aday dışa aktarma.** Agent `/task` içinde yalnız `src/search.ts` dosyasını değiştirebilir. Parametrik dışa aktarıcı (`taskCandidateSnapshotScript`) görev duraklatılmışken salt okunur ve ağsız container'da `lstat` ile dolaşır; dosya kümesi manifestle birebir eşit, dizinler yalnız `src` ve `tests`, her şey normal dosya, `nlink` 1, symlink yok ve boyut sınırlı olmalıdır. Korunan dosyalar sabit sha256 ile eşleşir; yalnız yazılabilir dosya içerik politikasından (UTF-8, bidi/kontrol karakteri, gizli bilgi kalıpları) geçip stdout'a yazılır. Host ayrıca `forbidden_patterns` (alt dize) ve değişmemiş adayı `candidate_invalid` olarak reddeder.

**Bağımsız doğrulayıcı.** Host, yeni bir staging volume'üne özgün paket dosyalarını ve yalnız aday `src/search.ts` dosyasını yazar. Doğrulayıcı container'ı çevrimdışı, salt okunur, yetkisiz (`--cap-drop ALL`) ve geçicidir. (a) Özgün görünür testler çalışır; çıkış kodu 0 olmalı ve TAP özetindeki test sayısı beklenenle eşleşmelidir (`process.exit` ile sahte geçiş yakalanır). (b) Host oracle'ı 40 gizli durum üretir (boş, tek öğe, hep eşit, aralık dışı, negatif, tekrarlı ve dışa aktarmadan sonra üretilen rastgele sıralı diziler). Durumlar stdin ile gelir, girdiler dondurulur, beklenen cevaplar hiçbir container'a girmez. Sonuç satırı koşuya özel bir nonce taşır; aday içe aktarılmadan önce gerçek `stdout.write` ve `JSON` yakalanır, adayın kendi çıktısı atılır, böylece aday sonucu taklit edemez. Koşu sonunda dosya hash'leri yeniden kontrol edilir. Zaman aşımı veya çıktı taşması başarısız kontrol sayılır; iptal ve Docker hataları yayılır. Cleanup kuralları kontrollü görevle aynıdır (`ControlledTaskCleanupError`).

**Sonuç.** Doğrulayıcı özeti `{passed, cases, visible_tests_passed, hidden_cases_passed}` olur; `cases` gizli durum sayısıdır. Yalnız ikisi de geçerse `passed` olur ve `src/search.ts` için sınırlı unified diff taşır; aksi halde `rejected/candidate_rejected`, diff yok.

## Kapsam dışı

Seçilen yaklaşım (strateji) bu artışta uygulanmadı: prompt'a eklenmez ve çalıştırmayı etkilemez. Lean ve plan görevleri, sunucu tarafı sonuç gönderimi/lease ve zarfın `execution_enabled: false` bayrağı değişmez. Lean sözleşmelerinin `contract_hash` değerleri aynı kalır; yazılım sözleşmesi ve onun kopyaları (koordinatör kataloğu, Go artifact test verisi) yeniden üretildi.

## Kabul sınırı

Bu ADR'deki testler sabit paket, kimlik, sözleşme ve dışa aktarıcı kontrolleri ile Node destekli doğrulayıcı vekili ve sentetik worker bağımlılıklarıdır; gerçek model çağrısı yapmaz. Gerçek hesapla uygulama içi çalıştırma, Windows/WebView2 koşusu, gerçek Docker doğrulayıcı kabulü ve ucuz modelin `software-bounds` görevini çözmesi ayrı kanıt gerektirir. Genel GO durumu değişmez.
