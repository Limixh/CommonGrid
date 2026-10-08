# ADR 0011 — Immutable kaynak teslimi ve doğrulayıcı köprüsü

Tarih: 2026-10-08. Durum: F0 development temeli. Tam v1 kapsamı ve CLI izolasyon kapısı korunur.

## Karar

cg-artifact/1 kaynak snapshot'ı deterministik STORE ZIP + exact manifest taşır. TS üretici ve Go parser aynı golden fixture ile sınanır. Kaynak yetkisi sözleşmedeki exact writable_paths'tir; bundle bağlamı task/version/hash/lease/base/strategy/purpose ile sabittir. Format result ve hard checkpoint içindir; soft context, binary ve diff/delete ayrı entegrasyon bekler.

Authenticated upload sunucu bağlamını oturum/lease'den türetir. Baseline sınıflandırma zorunlu bağımsız scanner yerine geçmez; nil/incomplete service kapanır. Trivy 0.75.0 ve resmi arşiv checksum'ları sabitlendi. Adapter yalnız development içindir; neutral dosya isimleri, trusted policy, temiz env/private home, offline/update/telemetry kapatma, deadline ve bounded output kullanır. Production OS scanner sandbox'ı değildir.

Migration 0006 depolama kotasını pending kayıtta byte yazılmadan ayırır. Tam byte sync/hash kontrolünden sonra ready olur; aynı kimlik/bağlam retry edilir. Pending de retained quota'ya dahildir. Immutable owner/binding/scan receipt ve pending→ready dışında mutasyon yoktur. Public metadata işlemleri ready authority'yi aynı transaction'da kontrol eder; trusted legacy fixture metotları korunur.

Private development vault os.Root, exclusive publish ve regular/reparse/hardlink kontrollerini kullanır. Windows directory fsync, OS identity isolation ve retention/GC eksikleri açıkça belgelenir. Interrupted publish fail-closed olabilir; quota rezervasyonu blind cleanup ile silinmez.

verification.Worker trusted pinned harness resolver kullanır. Harness yoksa claim alınmaz. Byte hash/size/format ve scanner yeniden kontrol edilir; inspection kopyası yerine orijinal archive yeniden parse edilir. Harness digest'i ve fenced claim eşleşmeden verdict yazılmaz. Client result veya task ServerCommand yürütülmez. Public HTTP claim/verdict yetkisi vermez.

## Kanıt ve kalan işler

174 Node testinin genel check'i, Go/build/vet; 112 PostgreSQL/HTTP kontrolü sıfır skip/failure ile geçti. DB zinciri gerçek Trivy/private vault/immutable registry kullanır; identity exchange ve harness fixture'dır. 115 artifact/verifier kontrolü geçti; Windows file-symlink privilege nedeniyle bir named skip kayıtlıdır, actual junction/reparse testi geçti. Real scanner acceptance zorunludur. Public kanıtlar artifact-delivery/artifact-postgres/artifact-foundations-windows-2026-10-08.json.

Genel Lean/yazılım harness'i, original pinned repository import, production S3/scanner sandbox/GC, soft untrusted context ve istemci upload/IDE akışı sonraki iştir. Uzak CI job'ı tanımlandı, çalıştırılmadı. UI/native/Temporal, gerçek OAuth veya gerçek AI inference bu aşamada tekrarlanmadı. Hesaplar ve önceki private CLI hacimleri kullanılmadı. execution_enabled=false; isolation_gate=not_evaluated.

Kurulum ve ayrıntılı wire/depolama/crash sınırları: [ARTIFACTS.md](../../docs/ARTIFACTS.md).
