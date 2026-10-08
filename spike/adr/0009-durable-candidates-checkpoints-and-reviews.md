# ADR 0009 — Kalıcı sonuç, checkpoint, inceleme ve tek kazanan

Tarih: 2026-10-08. Durum: **F0 bağımsız domain temeli ve yerel DB kabulü tamamlandı.** Tamamlanmış v1 kapsamı ve F1 GO kapısı korunur; development HTTP/desktop execution açık değildir.

## Karar

Lease/bütçe/outbox altyapısı üzerine üç append-only migration eklenir. `0001_domain.sql` değiştirilmez. Sonuç ve checkpoint receipt'leri kullanıcı, lease, immutable görev sürümü/hash'i, base commit ve artifact metadata'sına bağlıdır. Artifact opaque kimlik, SHA-256 ve boyut referansıdır; veritabanı kaydı gerçek dosya içeriğinin doğrulanması değildir.

Sonuç gönderimi geçerli aktif lease'i aynı transaction'da tamamlar ve zamanlama bütçesini settle eder. İlk doğrulanmış aday `awaiting_review` durumunu ve diğer lease'ler için durdurma isteğini atomik kaydeder. Durdurma isteği bütçeyi veya kullanıcı slotunu serbest bırakmaz; gerçek durdurma onayı/expiry ayrı işlenir. Önceden gönderilmiş rakip sonuçlar doğrulama ve incelemede kalabilir. SQL tekillik sınırı ve task kilidi yalnız bir `accepted` kazanana izin verir.

İnceleme grant'leri proje sahibi tarafından güvenilir sunucu koduyla kaydedilir. `maintainer` ve `community` politikaları farklı kalıcı rollerden uygunluk alır; kendi sonucunu incelemek reddedilir. Community grant'i yüksek itibarlı kullanıcıyı seçen ilerideki politika servisinin girdisidir, bu aşama gerçek itibar hesaplaması yapmaz. Otomatik kabul yalnız Lean proof için desteklenir. Kabul puan/merge/rebase/node-solved entegrasyonunu tamamlamaz.

Checkpoint JSON metadata'sı şema ve canonical JSON sınırından geçer. Parent aynı görev sürümü, hash, base ve uygun stratejiye bağlıdır; aktarım yalnız usable kayda yapılır. Bağımsız denemelerde başka kullanıcının ara durumunu benimsemek yeni görev sürümü gerektirir. Son usable kaydın bulunması otomatik süreç başlatmaz. Gerekli koşullarda lease settlement veya geç tamamlanan doğrulama görevi `resumable` yapar.

Doğrulama kuyrukları süreli claim ve opaque token kullanır. Sonuç claim'e ve artifact hash'ine bağlıdır; eski worker'ın verdict'i geçersizdir. Repository metotları güvenilir sunucu/verifier arabirimleridir; HTTP kimlik doğrulaması veya istemci tarafından gönderilebilen bir `verified` izni değildir. Gerçek paket importer'ı, secret/prompt-injection taraması ve Lean/yazılım doğrulayıcıları bu katmana sonraki entegrasyonda bağlanır.

Outbox lease aggregate sırasını korur; domain olayları entity kimliği taşır. Aynı lease birden fazla checkpoint/claim/inceleme olayı üretebilir; eski lease lifecycle tekilliği ayrı partial index ile korunur. Prompt, continuation metni, review yorumları, claim token ve artifact bytes olay payload'ına konmaz. Alıcı event ID deduplication ve uzlaştırma uygulamalıdır; exactly-once teslimat iddiası yoktur.

## Sınırlar ve tekrar

```powershell
npm run test:db
npm run check
```

Yerel DB kabulü PostgreSQL 18.6 üzerinde yeni, yalnız testlere ait schema'larda çalışır. Populated `0001` migration upgrade, mevcut lease olayları, idempotency, eski sözleşme ve verifier token fence, inceleme yetkisi, tek kazanan yarışı, checkpoint seçimi ve rollback sınanır. Genel kontrol ortak Go/TypeScript sözleşme semantiğini ve build'i kapsar. Son başarılı public raporlar `spike/results` altında, başarısız/ara koşular ve loglar `.local` altında kalır.

Son kaynaklarla **44 DB/guard kontrolü**, sıfır skip/failure geçti: 36 üst seviye DB testi, üç handoff alt senaryosu ve beş guard/unit kontrolü. `domain-postgres-windows-2026-10-08.json` tüm migration hash'lerini taşır; `0001` hash'i önceki raporla aynıdır. Genel kontrolde **169 Node testi (13 + 156)**, generated/typecheck, Go testleri ve frontend/Go build başarılıdır; `domain-foundations-windows-2026-10-08.json` ayrı kanıttır. Bağımsız incelemede bulunan tarihli checkpoint mode-change görünürlük hatası ve anlamlı expiry testi düzeltildi; claim nanosecond/microsecond binding ve completed replay de sınandı. Model/account çağrısı yapılmadı.

OAuth/HTTP yetki bağlantısı, gerçek itibar, cooldown, puan muhasebesi, merge/rebase, S3/scanner/verifier uygulaması, güvenli checkpoint pruning/retention worker, Temporal production sink/receiver ve cihaz heartbeat/reconciliation tamamlanmış sayılmaz. Bu aşamada gerçek hesap veya AI inference yapılmaz; test gerektirdiğinde Luna/Haiku tercihi korunur. Uzak CI yerel sonuçlarla geçmiş sayılmaz.
