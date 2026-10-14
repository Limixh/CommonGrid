# ADR 0022: Yazılım görevi sonuç paketi (yalnız yerel inşa)

Durum: Yerel paket adımı tamamlandı. Aşağıdaki ilk kapsam korunur; lease, IPC ve gönderim devamı [ADR 0023](0023-leased-software-submission.md) ile uygulanmıştır.

## Karar

ADR 0021'deki doğrulanmış `software-bounds` koşusunun diff'i artık deterministik bir `cg-artifact/1` sonuç paketine dönüştürülebilir. `packages/agent-adapters/src/software-result.ts`:

- `buildSoftwareResultBundle(task, {baseline, strategyId, leaseId, patch, candidateSha256})`: sabitlenmiş başlangıç dosyasına doğrulanmış unified diff'i `applyControlledPatch` (katı, bellek içi) ile yeniden uygular; sonucun sha256'sı `candidateSha256` ile eşit olmalıdır. Yol görev sözleşmesinin `writable_paths` listesinde olmalı (kontrollü `sum.mjs` görevi desteklenmez), `strategyId` sözleşmenin stratejilerinden biri olmalıdır. Ardından `buildArtifactBundle` ile tek dosyalı `purpose: "result"` paketi üretilir; bağlama `task_id`, `task_version`, `contract_hash`, `lease_id`, `workspace.commit` ve `strategy_id` taşır. Dönen değer `{bytes, sha256, size_bytes, file: {path, sha256, size_bytes}}` olur.
- `assertSoftwareResultDeliverable(task, input)`: aynı inşayı sabit yerel bir lease kimliğiyle (`lease-local-deliverability-check`) yapar ve baytları atar. Worker, yazılım görevlerinde doğrulayıcı geçtikten ve diff üretildikten sonra bu kapıyı çalıştırır: aday kaynaklı hata (`candidate_*`) `candidate_invalid`, sözleşme/bağlama hatası `asset_invalid` olur; doğrulayıcıdan geçip paket politikasına takılan bir aday (ör. U+200E) artık `passed` görünmez. Sonuç hiçbir yere gönderilmez veya saklanmaz.

**Görünmez metin politikası.** Worker aday politikası (`validateControlledCandidateBytes`, hem `controlledCandidateSnapshotScript` hem `taskCandidateSnapshotScript` içine gömülen dışa aktarıcı betikler dahil), `inspectArtifactText` ve Go `checkText` aynı kümeyi reddeder: TAB/LF/CR dışındaki C0/C1 denetim karakterleri, tüm Unicode `Cf` biçim karakterleri (sıfır genişlikli U+200B–U+200D/U+2060, bidi, ortadaki U+FEFF, yumuşak tire U+00AD, U+061C, tag karakterleri U+E0000–U+E007F), U+2028/U+2029, varyasyon seçicileri (U+FE00–U+FE0F, U+E0100–U+E01EF, Moğol U+180B–U+180D/U+180F), U+034F ve Hangul doldurucuları (U+115F, U+1160, U+3164, U+FFA0). Amaç, kullanıcının incelediği diff'te ve LLM gözden geçiricilerde gizli metin / ASCII kaçakçılığını önlemektir. Bedeli: ZWJ/ZWNJ ve U+FE0F içeren birleşik emoji dizileri ve bazı Fars/Hint yazıları da reddedilir; Türkçe harfler, yalın emoji, CJK ve NBSP kabul edilir. Üç katman aynı politikayı uyguladığından bu karakterler yüzünden doğrulayıcıdan geçip paketlenemeyen aday kalmaz; kapı yine de kalan teslim edilemezlikleri doğrulama sonrası ve sonuç yayımlanmadan önce yakalar. Hata kodları: aday kusurluysa `candidate_*` (`candidate_hash_mismatch`, `candidate_patch_apply_failed`, `candidate_not_deliverable`), sözleşmenin temsil edemediği görev/yol/strateji için `result_*`, diğer paket oluşturucu hataları `artifact_*` olarak geçer. Worker `candidate_*` kodlarını `candidate_invalid` olarak raporlamalıdır.

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

Bu ADR'deki kanıt birim ve golden testlerdir: deterministik baytlar, patch → paket gidiş-dönüşü (gerçek `software-bounds` sözleşmesi ve referans düzeltme), hash/yol/strateji reddi, görünmez karakterlerin üç katmanda da reddi ve Go koordinatörünün `testdata/software-result-bundle.zip` dosyasını `client-task.json` karşısında doğrulaması. Model çağrısı, ağ, yükleme veya gerçek tarama yoktur.
