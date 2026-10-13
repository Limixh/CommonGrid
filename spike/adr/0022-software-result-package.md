# ADR 0022: Yazılım görevi sonuç paketi (yalnız yerel inşa)

Durum: Uygulanıyor — yalnız paket oluşturucu ve teslim edilebilirlik kapısı; gönderim, IPC ve arayüz yok.

## Karar

ADR 0021'deki doğrulanmış `software-bounds` koşusunun diff'i artık deterministik bir `cg-artifact/1` sonuç paketine dönüştürülebilir. `packages/agent-adapters/src/software-result.ts`:

- `buildSoftwareResultBundle(task, {baseline, strategyId, leaseId, patch, candidateSha256})`: sabitlenmiş başlangıç dosyasına doğrulanmış unified diff'i `applyControlledPatch` (katı, bellek içi) ile yeniden uygular; sonucun sha256'sı `candidateSha256` ile eşit olmalıdır. Yol görev sözleşmesinin `writable_paths` listesinde olmalı (kontrollü `sum.mjs` görevi desteklenmez), `strategyId` sözleşmenin stratejilerinden biri olmalıdır. Ardından `buildArtifactBundle` ile tek dosyalı `purpose: "result"` paketi üretilir; bağlama `task_id`, `task_version`, `contract_hash`, `lease_id`, `workspace.commit` ve `strategy_id` taşır. Dönen değer `{bytes, sha256, size_bytes, file: {path, sha256, size_bytes}}` olur.
- `assertSoftwareResultDeliverable(task, input)`: aynı inşayı sabit yerel bir lease kimliğiyle (`lease-local-deliverability-check`) yapar ve baytları atar. Worker, yazılım görevlerinde doğrulayıcı geçtikten ve diff üretildikten sonra bu kapıyı çalıştırır: aday kaynaklı hata (`candidate_*`) `candidate_invalid`, sözleşme/bağlama hatası `asset_invalid` olur; doğrulayıcıdan geçip paket politikasına takılan bir aday (ör. U+200E) artık `passed` görünmez. Sonuç hiçbir yere gönderilmez veya saklanmaz.

**Teslim edilebilirlik açığı.** Worker'ın aday politikası (`validateControlledCandidateBytes`) artifact metin politikasından (`inspectArtifactText` / Go `checkText`) zayıftır: artifact politikası ayrıca C1 denetim karakterlerini (U+0080–U+009F), U+061C, U+200E ve U+200F'i reddeder. Doğrulayıcıdan "passed" geçen bir aday bu yüzden paketlenemeyebilir. Kapı bunu daha sonra değil, doğrulama sonrası ve sonuç yayımlanmadan önce yakalar. Hata kodları: aday kusurluysa `candidate_*` (`candidate_hash_mismatch`, `candidate_patch_apply_failed`, `candidate_not_deliverable`), sözleşmenin temsil edemediği görev/yol/strateji için `result_*`, diğer paket oluşturucu hataları `artifact_*` olarak geçer. Worker `candidate_*` kodlarını `candidate_invalid` olarak raporlamalıdır.

**Tarayıcı.** Yalnız `buildArtifactBundle`'ın kendi yerel metin denetimi çalışır (UTF-8, kontrol/bidi karakterleri, gizli bilgi kalıpları, `forbidden_patterns`). Bu yerel bir taban denetimidir; hiçbir zaman tarama başarısı olarak sunulmaz. Sunucudaki Trivy taraması zorunlu kalır.

## Neden gönderim yok

Yükleme etkin bir lease ister; koordinatörde lease uçları `409 isolation_gate_pending` döner ve `execution_enabled` kapalıdır. Etkin lease olamayacağı için bu adımda yükleme, IPC ve arayüz eklenmez; paket yalnız bellekte inşa edilip kapı için atılır.

## Ertelenenler

- `lease_id`'nin başlatma isteğine/worker boot'una taşınması.
- Native tarafta sınırlı paket saklama ve okuma IPC'si.
- Açık kullanıcı onayıyla webview `fetch` ile gönderim (CSRF dahil), yalnız etkin ve eşleşen bir lease varken.
- Paketlenmiş uygulama kimlik doğrulaması.
- Sunucu tarafı tarama ve doğrulama sonucunun gözlenmesi.

## Kabul sınırı

Bu ADR'deki kanıt birim ve golden testlerdir: deterministik baytlar, patch → paket gidiş-dönüşü (gerçek `software-bounds` sözleşmesi ve referans düzeltme), hash/yol/strateji reddi, U+200E açığının sabitlenmesi ve Go koordinatörünün `testdata/software-result-bundle.zip` dosyasını `client-task.json` karşısında doğrulaması. Model çağrısı, ağ, yükleme veya gerçek tarama yoktur.
