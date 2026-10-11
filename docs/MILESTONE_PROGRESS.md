# Milestone ilerleme ve gerileme hesaplayıcısı

2026-10-11 · PROJECT_SPEC1.2.md §11.2. Saf Go hesaplama çekirdeği: `services/coordinator/internal/progress`. Gerçek ölçüm, kalıcılık, API/UI ve puan dağıtımı bu teslimde yoktur.

## Ne yapar

`progress.Evaluate`, doğrulanmış `contract.TaskContract` ile güvenilir checker'ın ürettiği sonuçları alır. Sonuçlar tek bir artifact'a aittir (`Measurement`) ve görev kimliği, sürüm, `contract_hash` ve base commit bağlamını taşır. İsteğe bağlı önceki ölçüm aynı sözleşmeye ait fakat başka artifact'tan olabilir; iki artifact kimliği raporda ayrı tutulur.

Çıktı (`Report`): sözleşme sırasındaki milestone durumları, geçen ağırlık toplamı, gösterilecek ilerleme, kritik engeller, kazanılan ve gerileyen kimlikler, ölçülmeyen milestone'lar ve sınırlama kodları. Girdi sırası sonucu değiştirmez.

## Kurallar

| Konu | Davranış |
|---|---|
| Durumlar | Girdide yalnız `pass`, `fail`, `blocked`. Sonucu olmayan milestone `not_measured` raporlanır; bu değer girdi olarak gönderilemez |
| Ağırlık | Sözleşme ağırlıkları yeniden normalize edilmez. Geçen ağırlık, geçen milestone ağırlıklarının tam (`big.Rat`) toplamıdır ve bir kez en yakın float64'e yuvarlanır; en çok 1 gösterilir |
| Toplam sınırı | Sözleşme doğrulamasındaki ile aynı hesap ve `1+1e-12` toleransı; aşan tanım reddedilir. Testle validator ile uyumu sınanır |
| Kritik sınır | Geçmeyen (fail, blocked veya ölçülmemiş) kritik milestone varken gösterilen ilerleme en fazla 0,5. Sınır yalnız değeri düşürdüyse `critical_cap_applied` true olur |
| blocked | Geçiş sayılmaz. Lean bağımlılık kanıtını bu paket üretmez; checker `blocked` dediyse işlenir |
| Gerileme | `pass` iken şimdi `fail` veya `blocked` olan milestone `regressed` |
| Kazanım | Önceki ölçümde `pass` olmayıp şimdi `pass` olan `gained`. Önceki ölçüm yoksa karşılaştırma yapılmaz |
| Boş tanım | `progress_available=false`, ilerleme 0, sınır `no_milestones_defined`. Tamamlanmış veya yüzde yüz sayılmaz. Test grubu eşit ağırlıklandırması yoktur |
| Sınırlar | `milestones_not_measured` (sonucu olmayan milestone var), `defined_weight_below_one` (tam ağırlık toplamı 1'den az; yeniden normalize edilmez) |

Eksik yeni sonuç önceki `pass` ağırlığını korumaz: güncel `passed_weight` yalnız güncel `pass` sonuçlarından hesaplanır. `unconfirmed` listesi bu kanıt eksikliğini `regressed` listesindeki açık `fail`/`blocked` sonuçlarından ayırır. Eksik kritik sonuç da 0,5 sınırını uygular.

Float64 yuvarlama veya sözleşmenin toplam ağırlık toleransı, geçmeyen çok küçük bir milestone'u sayısal olarak gizleyebilir. Tüm milestone'lar geçmemişken yuvarlanan `progress` değeri 1 çıkarsa bunun yerine en yakın daha küçük float64 ile sınırlandırılır; `passed_weight` tam toplamdan bir kez yuvarlanmaya devam eder. Yüzde biçimlendirmesi bu küçük farkı yine `%100` gösterebilir. Çağıran tamamlanma kararı ve yüzde etiketi için milestone durumlarını ve `limits` kodlarını birlikte kullanmalıdır; yalnız yuvarlanmış yüzde tamamlanma kanıtı değildir.

Reddedilenler `*RejectionError` ile döner, `errors.Is` ile ayrılır: `ErrContextMismatch` (görev kimliği, sürüm, hash, base commit), `ErrInvalidMeasurement` (artifact hash biçimi), `ErrUnknownMilestone`, `ErrDuplicateMilestone`, `ErrInvalidStatus`, `ErrInvalidContract`. Birden çok hata varsa hangisinin döneceği sonuç sırasına bağlı değildir.

## Sınırlar ve yapılmayanlar

- Checker kimliği doğrulanmaz ve girdiye sunucu yetkisi kazandırılmaz. Çağıran yalnız güvenilir sunucu sonucunu verir; model beyanı veya istemci verisi doğrulanmış ilerleme değildir.
- `pass` iken sonucu bulunmayan milestone gerileme sayılmaz, `unconfirmed` olarak ayrı raporlanır; bozulduğu kanıtlanmış değildir. Puan etkisi sonraki entegrasyonda kararlaştırılır.
- Gerçek ölçüm harness'i (test grupları, gizli testler, Lean bağımlılık denetimi) yok; `check` alanı çalıştırılmaz.
- Sonuçlar ve rapor saklanmaz; veritabanı, API ve arayüz yok. Orkestratör sinyali (§10.3) bu rapora henüz bağlı değil.
- Checkpoint puan dağıtımı (§11.1) ve gerileyen milestone'dan payın sıfırlanması uygulanmadı; yalnız bu karar için gereken kimlikler hesaplanır.
- Paket shell, ağ, model, saat veya rastgelelik kullanmaz; testi bu içe aktarmaları denetler.

Kontrol: `node scripts/go.mjs test ./internal/progress`.
