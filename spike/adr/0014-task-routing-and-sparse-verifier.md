# ADR 0014 — Araç yolu ve boş elemanlı dizi kontrolü

Tarih: 2026-10-09. Durum: önceki Luna adayı genişletilmiş kontrolde reddedildi; kullanıcının sonraki devam isteğiyle üretilen yeni Luna adayı 34 vaka ve patch kabulünü geçti. Dar görev kabulü tamamlandı. GO verilmedi; `execution_enabled=false`, `isolation_gate=not_evaluated`.

## Problem ve değişiklik

Önceki Luna koşusunda altı callback sonrası dosya değişmedi; komut sonuçları saklanmadığı için neden bilinmiyor. Yeni tanı kayıtları yalnız sonuç kategorisi, çıkış kodu ve stdout/stderr byte sayısını içerir. `task_exec` açıklaması doğrudan argv, `/task`, Node, örtük shell/stdin olmaması ve 3 saniyelik varsayılan süreyi açıkça belirtiyor. Bu açıklama değişikliği önceki başarısızlığın nedenini kanıtlamaz.

AI kullanılmadan aynı callback → task → cevap yolu [yedi Docker kontrolünde](../results/task-routing-diagnostics-windows-2026-10-09.json) dosya okudu, değiştirdi ve bağımsız 32 vaka ile patch uygulamasını geçti. Ardından `f09a592` kaynağıyla aynı izole Codex profili ve yalnız `gpt-6-luna` kullanılarak **bir** gerçek görev çalıştırıldı. [Üç callback başarılı döndü](../results/managed-task-luna-diagnostics-windows-2026-10-09.json); dosya değişti, önceki 32 vaka ve gerçek [patch](../results/managed-task-luna-diagnostics-2026-10-09.patch) uygulaması geçti, kaynaklar temizlendi.

Üretilen kod `every` ile tüm diziyi önceden kontrol ediyor. `every` boş yuvaları atladığından `Array(1)` ve `[1,,]` için beklenen `TypeError` yerine `RangeError` oluşuyor. İlk 32 vaka JSON üzerinden taşındığı için gerçek boş yuvaları sınamıyordu. JSON bu yuvaları `null` yapar; bu nedenle yalnız JSON vakası eklemek hatayı yakalamaz.

## Karar ve kanıt

`70fd7c6` doğrulayıcısı önceki 32 vakayı korur ve iki gerçek boş elemanlı diziyi child içinde oluşturur. Beklenen sonuçlar host oracle'ında kalır; aday yeni readonly, ağsız namespace'te çalışır. Görev yönergesi her pozisyondaki değeri toplama öncesi doğrulamayı ve ilk hatada durmayı açıkça belirtir.

[Yeni Docker kabulü](../results/coding-verifier-sparse-windows-2026-10-09.json) 25 kontrolü geçti. Doğru fixture 34 vakayı geçti; `every` kullanan kontrol adayı eski 32 vakayı geçip iki boş yuva vakasında reddedildi. Özgün AI adaylarının hash'leri doğrulanarak ek model çağrısı olmadan aynı 34 vakada replay yapıldı:

| Bu tarihli replay'in adayı | Önceki 32 vaka | İki boş yuva vakası | Replay kabulü |
|---|---|---|---|
| Yeni Luna çıktısı | Geçti | Başarısız | Reddedildi |
| Önceki Haiku çıktısı | Geçti | Geçti | Dar görev kapsamında geçti |

İlk replay Docker zaman aşımı nedeniyle doğrulanamadı; başarılı diye kaydedilmedi. Sonraki replay ve ayrı fixture cleanup geçti. İlk model raporları değiştirilmedi. Luna'nın 32 vaka başarısı kendi kaynak ve kapsamıyla korunur; bu durum güncel aday kabulü değildir. Bu AI'sız replay adımında boş yuva hatası bulunduktan sonra yeni AI çağrısı yapılmadı; pahalı model/API fallback yoktur.

## Sonraki gerçek Luna görevi

Kullanıcının sonraki normal devam isteğiyle `338c05c` kaynağı ve aynı ilk Codex profili kullanılarak **bir** yeni gerçek görev çalıştırıldı. [Yeni kabul kaydında](../results/managed-task-luna-accepted-windows-2026-10-09.json) istenen ve gözlenen `gpt-6-luna` doğrulandı; üç callback başarılı/exit=0 döndü ve provider turn tamamlandı. Dosya değişti; yeni aday güncel verifier'ın 32 JSON ve çocuk süreçte oluşturulan iki gerçek boş yuvalı dizi örneğini, toplam 34 vakayı geçti. [Yeni patch](../results/managed-task-luna-accepted-2026-10-09.patch) uygulaması ve roundtrip hash eşitliği ile cleanup doğrulandı.

Yeniden login/logout veya credential kopyalama yapılmadı; otomatik model retry, pahalı model veya ücretli API fallback kullanılmadı. Önceki değişmemiş aday, 32 vaka başarısı ve sonraki 34 vaka reddi kendi tarihli raporlarında korunur. Özgün Haiku adayının 34 vaka replay'i ile bu yeni gerçek Luna görevi yalnız dar `sumIntegers` kabulünü tamamlar.

## Oturum, kontrol ve sınır

Aynı Claude profili [yaklaşık 11 saat sonra](../results/managed-session-delayed-claude-windows-2026-10-09.json) yeniden giriş olmadan status → restart → status kontrolünü geçti. Aradaki provider etkinliği gözlenmedi; bu sonuç token yenilemesini kanıtlamaz. Ayrı resmi Codex kota sorgusu başarılıdır; kullanım/reset değerleri private kalır ve snapshot kullanım izni ya da tükenme/reset kanıtı değildir. İki profil sonraki normal gözlemler için korunur.

[Yönerge değişikliği](../results/luna-routing-foundations-windows-2026-10-09.json) ve [34 vaka düzeltmesi](../results/coding-verifier-sparse-foundations-windows-2026-10-09.json) için ayrı yerel `npm run check` geçti: her birinde 284 Node testi, tip/şema kontrolleri ve derlemeler. Önceki [32a766d için 11 başarılı GitHub işi](../results/github-foundations-32a766d-2026-10-09.json) tarihli kayıttır. Sonraki [338c05c GitHub kaydı](../results/github-foundations-338c05c-2026-10-09.json), run `37906781578`, aynı kaynağın 11 işinin completed/success olduğunu gösterir; daha sonraki kodu veya gerçek hesap/model kabulünü kapsamaz.

Sıradaki çalışma mevcut izole process kesintisi, profil sahipliği ve güvenli cleanup kabulüdür; yeni genel altyapı katmanı değil, mevcut yaşam döngüsündeki gerekli düzeltmeler ve kontrollerdir. Doğal oturum yenilemesi, gerçek kota/eşzamanlılık ve geniş host/araç kabulü ayrıca bekler. Bu kontrol dar `sumIntegers` fixture'ıdır; genel kod doğruluğu, production izolasyonu veya tüm v1 tamamlandı iddiası üretmez. [GO listesi](../../docs/GO_GATE.md), [oturum prosedürü](../cli-session/MANAGED_SESSIONS.md) ve tam v1 hedefi korunur.
