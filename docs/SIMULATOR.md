# Seed'li çevrimdışı orkestratör simülatörü

Yol haritası Faz 5a'nın ilk kullanılabilir parçası. Aynı problem, gönüllü kapasitesi ve zamanlama bütçesinde farklı zamanlama politikalarını karşılaştırır. Gerçek CLI, model, Docker, ağ, Temporal veya production scheduler çalıştırmaz; gerçek `sleep` yoktur, zaman bir olay kuyruğundaki sanal saniyedir.

**Bu araç gerçek model başarısını veya verimliliğini ölçmez ve ürün kabulü değildir.** Sonuçlar yalnız senaryo dosyasındaki sentetik varsayımları yansıtır; gerçek model korelasyonu, handoff maliyeti ve gönüllü davranışı gerçek görev testleriyle ölçülür (spec §10.8). Milestone ölçümü ile entegrasyon (Görev 3) ve gerçek orkestratör (F5b) kapsam dışıdır.

## Çalıştırma

```powershell
node scripts/go.mjs run ./cmd/simulate --scenario internal/simulation/testdata/scenarios/trap-branch.json --seed 7 --samples 30
node scripts/go.mjs run ./cmd/simulate --scenario <dosya> --seed 7 --policies single,fixed:3,round-robin,least-attempted --out rapor.json
node scripts/go.mjs test ./internal/simulation ./cmd/simulate
```

`--seed` zorunludur; `--samples` verilmezse senaryonun `recommended_samples` değeri kullanılır. Çıkış varsayılan olarak stdout'a gider. Üretilen raporlar commit edilmez; yalnız `internal/simulation/testdata/golden` altındaki test golden dosyası bilinçli takip edilir.

## Senaryo formatı

`commongrid.simulation.scenario` sürüm `1.0`; canlı görev şemasından ayrı sürümlenir, bilinmeyen alan reddedilir. Görev sözleşmeleri `contracts_file` (katalog biçimi, senaryoya göre göreli) veya satır içi `contracts` ile verilir ve her biri `contract.Validator` ile (şema, semantik, `contract_hash`) doğrulanır. AND/OR ilişkileri ve sentetik sonuçlar yalnız senaryoda bulunur.

- `nodes`: ağaç düğümleri. `relation`: `leaf`, `and` (tüm çocuklar) veya `or` (herhangi biri). Düğüm kimliği ilgili sözleşmenin `node_id` değerine eşit olmalıdır. Yaprakta `synthetic`: `work_sec` aralığı, profil başına `success_probability` ve ortak kusur için `flaw_probability` (`default` profil zorunlu), isteğe bağlı `artifact_variants` ve `verification_pass_probability`.
- `budget.total_agent_sec`: toplam ajan-zaman bütçesi. Her deneme başlarken sözleşmenin `time_limit_sec` değeri atomik rezerve edilir, kullanılmayan kısım dönüşte serbest kalır; sığmayan deneme başlamaz.
- `volunteers`: kimlik, profil, sağlayıcı, `slots`, `join_sec`, isteğe bağlı `online_sec` aralığından örneklenen ayrılma zamanı.
- `outages` (sabit pencere) ve `random_outages` (koşu başına önceden örneklenen pencereler): sağlayıcı kesintisi.
- `verification` / `review`: merkezi doğrulama ve (sözleşme `review.policy` değeri `auto` değilse) inceleme kuyruğu; çalışan sayısı ve süre aralığı. `handoff.overhead_sec`: devralma yükü.

Sözleşmenin `depends_on` alanı uygulanır (önkoşul çözülmeden başlamaz); `parallelism.cap`, `handoff.*` ve `environment.time_limit_sec` denemeleri sınırlar. Handoff açık olan görevde ayrılan gönüllünün denemesi son checkpoint'ten başka gönüllüde sürer; kayıp çalışma ve yük raporlanır. Handoff kapalıysa deneme `interrupted` veya `provider_outage` ile başarısız olur.

Fixture'lar `testdata/scenarios` altında: `easy-or`, `and-all-children`, `trap-branch`, `shared-profile-failure`, `duplicate-artifact`, `provider-outage`, `verification-review-queue`. `testdata/contracts.json` katalog görevlerinden türetilmiş, yeniden hash'lenmiş sentetik sözleşmelerdir.

## Adil karşılaştırma

Rastgele sayılar sıralı bir akıştan çekilmez. Her değer `(seed, koşu, alan, varlık anahtarı)` üzerinden SHA-256 ile türetilir: deneme süresi/sonucu `(görev, deneme sırası)`, ortak profil kusuru `(görev, profil)`, artifact doğrulama sonucu `(görev, artifact)`, gönüllü ayrılması gönüllü kimliğiyle, rastgele kesintiler kural ve sırayla anahtarlanır. Bir politikanın kaç değer tükettiği ya da hangi sırayla istediği diğerinin dünyasını değiştirmez; aynı `(görev, deneme sırası)` her politikada aynı süre ve çekimleri alır. Rapordaki `worlds[].digest` her örneğin önceden örneklenen dünyasının özetidir ve politikalar arası eşitlik koşu sırasında denetlenir.

## Politikalar

`single` (aynı anda tek deneme), `fixed:N` (en çok N eşzamanlı deneme), `round-robin` ve `least-attempted`. `single` ve `fixed:N` ağacı derinlik öncelikli gezer ve bir yaprağa art arda 3 deneme verir; `round-robin` ve `least-attempted` boş gönüllü yuvalarının tümünü kullanır. Hepsi görev başına `parallelism.cap` sınırına uyar. Politikalar gizli sentetik sonucu göremez.

## Rapor

`commongrid.simulation.report` sürüm `1.0`: `seed`, `scenario` (kimlik, dosya SHA-256), `budget`, `samples`, `worlds` ve politika başına:

- `solved_runs`, `unsolved_runs`, `solve_rate`, `end_reasons` (`solved`, `budget_exhausted`, `no_capacity`, `stalled`, `horizon_reached`);
- `agent_hours_total` ve `agent_hours_per_solved` (çözülmeyen koşuların harcaması dahil), `wall_time_sec_solved_runs` (yalnız çözülen koşular: sayı, ortalama, medyan, en büyük);
- `attempts`: başlatılan, başarısız (nedene göre) ve oranı, yararlı, yinelenen, yerine geçilen, iptal edilen;
- `queues`: doğrulama, inceleme ve devralma bekleme süreleri; `correlation`: ortak profil kusuru ve yinelenen artifact sayıları; `handoff`: devralma, kayıp çalışma, yük;
- `runs`: çözülmeyenler dahil her koşunun kaydı.

Tanımsız bir metrik (ör. hiç çözülmediğinde çözülen başına ajan-saat, boş kuyruğun ortalama beklemesi) `"not_measured"` metnidir; sıfır uydurulmaz. Gerçek sıfır sayılar (ör. 0 çözüm oranı) sayı kalır. Aynı senaryo, seed, örneklem ve politika listesi baytı baytına aynı JSON'u üretir: alan sırası sabit, map anahtarları sıralı, ondalıklar 6 basamakla biçimlenir.

## Bilinen sınırlar

Üst hedefin ayrıca doğrulanması, sentetik milestone/gürültülü ilerleme sinyalleri, rastgele politika, Thompson sampling ve erken kapatma oranı henüz yoktur. Aday doğrulandığında yeni kiralama durur ancak çalışan kardeş denemeler iptal edilmez; yaprak çözülünce iptal edilir. Gönüllü ayrılması yalnız bir kez (yeniden katılma yok) modellenir. Bekleme süreleri merkezi kuyruk süreleridir, ajan-zaman bütçesinden düşmez.
