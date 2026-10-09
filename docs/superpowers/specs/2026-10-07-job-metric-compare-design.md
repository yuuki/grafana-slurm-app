# Job Metric Compare — UI/UX Design

Date: 2026-10-07
Status: Approved (UI/UX, Phase 1 scope)

## Overview

新ページ「Metric Compare」を追加する。ユーザーが選んだ **1 つのメトリクス**
（例: `DCGM_FI_PROF_PIPE_TENSOR_ACTIVE`）について、**ジョブごとに 1 枚の時系列**
を描き、多数のジョブを横並びで比較する。

想定ユースケース:

1. **比較 (compare)**: 同じ学習コードの複数ラン（ハイパーパラメータ違い、ノード数違い）で
   Tensor Core 利用率の推移がどう違うかを見る。
2. **スクリーニング (scan)**: 直近 1 週間の 50 ジョブを流し見て、
   「途中で利用率が落ちた」「立ち上がりが遅い」ジョブを素早く見つける。

既存の Job Dashboard は「1 ジョブ × 多メトリクス」、本ビューは「多ジョブ × 1 メトリクス」で、
両者は直交する。

## Goals / Non-Goals

Goals:

- 1 メトリクス × 最大 48 ジョブの時系列比較。
- 開始時刻の異なるジョブを **経過時間軸** で、長さの異なるジョブを **進捗率軸（0–100%）** で揃えて比較できる。
- 外れたジョブを目で探さなくてよい並べ替え（中央値プロファイルからの乖離順）。
- URL で状態を共有できる（Slack に貼って「このジョブだけ形が違う」と言える）。

Non-Goals (初版):

- 複数メトリクスの同時比較（メトリクス切替は可能だが同時表示はしない）。
- ジョブ内の per-GPU / per-node 系列の完全表示（ドリルダウンで Job Dashboard へ渡す）。
- 高度な統計的異常検知（Phase 2。初版は中央値との差のみ）。
- 48 ジョブを超える一括表示（ページングもしない。フィルタで絞り込んでもらう）。

## Information Architecture

### ルートとナビゲーション

- 新ルート: `/a/yuuki-slurm-app/compare`
- `plugin.json` の `includes` に `Metric Compare`（icon: `chart-line`）を追加し、
  Job Search と Node Health の間に置く。

### 入口（3 箇所）

| 入口 | 操作 | 引き継ぐ状態 |
|------|------|--------------|
| Job Search | テーブルに行チェックボックスを追加 → ツールバー `Compare metric (n)` | 選択ジョブ ID 群。未選択時は現在の検索フィルタ全体 |
| Job Dashboard / Metric Explorer | Metric Explorer の各メトリクスカードに `Compare across jobs` ボタン（Phase 1。ピン留めパネルのメニューは後続） | メトリクス名 + 当該ジョブを Baseline に。ジョブ集合は「同ユーザー・同ジョブ名の直近ジョブ」を初期値に |
| ナビ直接 | サイドメニューから | 前回の状態（localStorage） |

Job Dashboard からの入口が最も重要。「このジョブの Tensor 利用率、前回と比べてどう?」という
動機は 1 ジョブを見ている最中に生まれるため。

## Page Layout

上から 3 段構成。

```
┌ Header ─────────────────────────────────────────────────────────────┐
│ Cluster [gpu-a ▾]  Metric [DCGM_FI_PROF_PIPE_TENSOR_ACTIVE ▾] (gauge)│
│ Jobs  [Search filter: user=alice, partition=gpu, 7d ✎]  48 jobs      │
│       Baseline [#10231 ✕]                                            │
├ View options ───────────────────────────────────────────────────────┤
│ [Grid|Overlay]  X:[Elapsed|Absolute]  Reduce:[mean+band ▾]           │
│ Y:[Shared|Independent]  Sort:[Deviation ▾]  Columns:[auto ▾]         │
├ Body ───────────────────────────────────────────────────────────────┤
│ Grid: ジョブごとの小型時系列セル (small multiples)                    │
│ Overlay: 1 枚の大きなチャートに全ジョブを重ねる                        │
└─────────────────────────────────────────────────────────────────────┘
```

### 1. Header — 何を比べるか

**Metric picker**

- 検索付き Combobox。候補は「対象ジョブ集合のノード群に存在するメトリクス名」。
  初版は `label values __name__`（ノードマッチャ付き）で取得し、ジョブごとの series discovery
  は行わない（多ジョブで重いため）。
- 先頭に **Suggested** グループ: Tensor Active、SM Active、GPU Util、FB Used、Power、
  NVLink/IB 帯域など GPU 学習で頻出のもの（静的リスト）。ピン留めメトリクスの取り込みは後続。
- メトリクス型バッジ（gauge / counter / histogram）を表示。counter は自動で
  `rate(...[$__rate_interval])` を適用し、`rate()` 適用中であることをバッジで明示。
- `Edit PromQL`（任意式の指定）は Phase 1 では提供しない。

**Job set**

2 つのモードを持つ。既定は Filter モード。

- **Filter モード**（既定）: Job Search と同じフィルタ（user / account / partition / name /
  state / nodes / elapsed / 期間）。ヘッダにフィルタ要約を表示し、`Edit filter` で
  Job Search の `JobFilters` コンポーネントと時間範囲入力を展開して編集する。
  スクリーニング用途向け。
- **Pick モード**: ジョブ ID を明示指定（Job Search からの選択、ID の直接入力）。比較用途向け。

表示上限は 48 ジョブ（4 列 × 12 行）。フィルタ結果が 48 を超える場合は開始時刻の新しい順に
48 件を採用し、ヘッダに「Showing 48 of 213 jobs. Narrow the filter to compare others.」と表示する。
ページングや `Load more` は設けない。上限を固定することで、乖離スコアの比較母集団が
画面に見えているジョブと常に一致する。

Pick モードでも 48 を上限とし、超える選択は Job Search 側の `Compare metric` ボタンで
「48 件まで」と警告して止める。
GPU を使わないジョブ（`gpusTotal == 0`）は GPU メトリクス選択時に自動で除外し、
除外件数を「3 jobs hidden (no GPUs)」と表示する。

**Baseline**

- 任意の 1 ジョブを Baseline に固定できる（セルのメニュー `Set as baseline`）。
- Grid では全セルに Baseline の系列を灰色点線で重ねる。「いつものラン」との差分が一目で分かる。

### 2. View options — どう見せるか

| オプション | 選択肢 | 既定 | 理由 |
|-----------|--------|------|------|
| Layout | Grid / Overlay | Grid | スクリーニングは Grid、少数の精密比較は Overlay |
| X axis | Elapsed / Progress / Absolute | Elapsed | Elapsed は開始時刻を揃える。Progress は開始〜終了を 0–100% に正規化し、長さの違うジョブのフェーズ（warmup、評価、checkpoint）を揃える。Absolute は同時刻の干渉（共有ストレージ等）調査用 |
| Reduce | mean / mean + min–max band / max / min | mean + band | 1 ジョブ = 多ノード × 多 GPU を 1 本にする。band で GPU 間ばらつき（ストラグラー）も見える |
| Y scale | Shared / Independent | Shared | 共有しないとセル間の高さ比較が誤解を生む。値域が桁違いのメトリクス用に Independent |
| Sort | Deviation from median / Mean ↑↓ / Start time / Duration / Job ID | Deviation | 「おかしいジョブ」を左上に集める |
| Columns | auto / 2 / 3 / 4 / 6 | auto | 画面幅に応じて。6 列でセル高を下げると 48 ジョブを 1〜2 画面で流せる |
| Elapsed range | 全体 / 先頭 N 時間 | 全体 | X=Elapsed 時のみ。共有 X 軸 = 最長ジョブ長で、短いジョブが潰れる場合は先頭 N 時間に絞る |

選択状態はすべて URL クエリに反映する（`metric`, `jobs` or filter params, `layout`, `x`,
`reduce`, `y`, `sort`, `baseline`）。localStorage は「前回の状態」の復元にのみ使う。

#### Progress 軸の扱い

- 各ジョブの系列を `(t - start) / (end - start)` で 0–100% に写像し、200 ビンに再サンプリングする。
  ビン内は Reduce と同じ集約を使う。
- RUNNING ジョブは `end = now` とみなすため進捗率が確定しない。セルに「running: progress
  relative to now」と注記し、乖離スコアの計算からは除外する（Sort では末尾）。
- 同期カーソルとツールチップは「42% (3h 31m elapsed)」のように進捗率と実経過時間を併記する。
- ジョブ長の差が大きいと形が引き伸ばされて見えるため、セル下部の要約統計に duration を常に出す。

### 3. Body

#### Grid (small multiples)

各セル:

```
┌──────────────────────────────────────┐
│ ● #10388 llm-pretrain   FAILED   ⋮  │  ← 状態色ドット / ID / 名前 / 状態 / メニュー
│ ╭──────╮╭────────────╮__________    │  ← スパークライン（band + mean 線 + baseline 点線）
│ mean 60%   p95 68%   8h 20m   16 GPU │  ← 要約統計
└──────────────────────────────────────┘
```

- セル高は既定 96px（Columns=6 時は 72px）。軸目盛りはセル内に描かず、
  ページ上部に共有の X/Y 軸凡例を 1 つだけ置く（Shared Y のとき）。
- **同期カーソル**: 1 セルにホバーすると、全セルに同じ経過時間の縦線と値ツールチップを出す。
  「開始 2 時間後に全ジョブで落ちているか、このジョブだけか」が即座に分かる。
- **乖離ハイライト**: Sort=Deviation 時、乖離スコア上位（閾値超え）のセルを赤枠に。
  ツールチップで「median から平均 -32pt」のようにスコアの中身を表示する。
- **ジョブ状態**: セル左上に既存 `jobStateStyles` の色。RUNNING はセル右端を破線で
  「継続中」と示す。FAILED/TIMEOUT は終了時点に小さな × マーカー。
- **クリック**: セル本体クリックで拡大プレビュー（モーダル、per-GPU 系列まで展開、
  GPU/ノード別凡例）。モーダル内に `Open job dashboard` リンク。
- **選択**: Shift/Cmd クリックで複数セル選択 → `Overlay selected` で Overlay に絞り込み遷移。
- **データなし**: 系列がないセルは「No data for this metric」とグレーで表示し、
  Sort では末尾に回す（カウントはヘッダに表示）。

#### Overlay

- 大きなタイムシリーズ 1 枚に、選択（または上位 10）ジョブの mean 線を重ねる。
- 10 本を超えると判読不能なので、超えた場合は警告と「Grid で見る」導線を出す。
- 凡例はテーブル形式（Job ID / 名前 / mean / p95 / duration）で、凡例行ホバーで
  該当線を強調、他を薄くする。
- Baseline は太めの灰色線。

### 4. 状態とフィードバック

- ロード中: セルごとのスケルトン（全体スピナーにしない）。見えているセルから順に埋まる。
- 部分失敗: 失敗セルに `Retry`。ページ上部に「4 of 48 jobs failed to load」。
- クラスタに `metricsDatasourceUid` 未設定: 空状態で Configuration への導線。
- 権限: 既存のクラスタ access rule に従い、閲覧不可のジョブは Job Search と同様に出さない。

## Deviation Score

初版は説明可能性を優先した単純な指標とする。

1. 現在の X 軸上で（Absolute のときは Elapsed で計算する）、表示中の全ジョブ（RUNNING と no data を除く）を
   共通グリッド（200 点）に再サンプリングする。Elapsed では各ジョブの存在区間のみ値を持つ。
2. 各グリッド点で値が存在するジョブの中央値を取り、**中央値プロファイル** を作る。
   ある点で値を持つジョブが 3 未満なら、その点はスコア計算に使わない。
3. ジョブ j のスコア = 有効点での `|v_j - median|` の平均。符号付き平均も保持し、
   ツールチップの「平均 -32pt」に使う。
4. ハイライト閾値: スコアが全ジョブのスコア中央値 + 2×MAD を超えたら赤枠。
   ただし、スコアが全プロファイル値の最大絶対値の 5% 未満なら赤枠にしない（似たジョブが並んで
   MAD がほぼ 0 になると、わずかな差でも赤枠になるのを防ぐ。2026-10-09 の画面確認で追加）。
   Y=Shared 時は値の単位のまま、Independent 時も同じ（スコアは表示スケールに依存しない）。

Phase 2 での高度化（DTW による形状距離、change-point の位置比較、MetricSifter 連携など）に
備え、スコア計算は `(series[], axis) => Map<jobKey, {score, signedMean, flagged}>` の
純関数インターフェースに切り出し、Sort ドロップダウンに手法を追加できるようにしておく。

## Interaction Flows

**Flow A: Job Dashboard から比較**

1. Job #10388 のダッシュボードで Tensor Active パネルの `⋮ → Compare across jobs`。
2. Metric Compare が開く。Metric=Tensor Active、Baseline=#10388、
   Job set=Filter（同ユーザー・同ジョブ名・直近 30 日）。
3. Grid で他ランと並び、#10388 だけ 6 時間目に急落していることが分かる。

**Flow B: スクリーニング**

1. サイドメニューから Metric Compare。Metric を Suggested から Tensor Active に。
2. Job set フィルタで partition=gpu、期間=7d、state=All。
3. Sort=Deviation、Columns=6 で上位を確認。赤枠セルをクリックして拡大、
   per-GPU 展開で特定ノードのストラグラーを確認 → `Open job dashboard`。

## Performance Design（UX に効くもの）

- 1 セル 1 クエリにしない。既存 `fetchJobsUtilizationBatch` と同様に、
  ジョブ群のノード和集合に対し `<reduce> by(instance)` を 1 本（または少数バッチ）で
  `query_range` し、クライアント側でジョブの `[start, end]` と担当ノードで切り出して
  ジョブ単位に再集約する。band 用に `min/max by(instance)` を追加取得。
- step はセル幅から逆算（1 セル ≈ 200 点）。100 ジョブでも応答サイズを抑える。
- 期間が大きく離れたジョブ群は時間方向にバッチを分ける（空白期間を取得しない）。
- バッチは直列に実行し、Prometheus への同時負荷を抑える。上限 48 ジョブのため
  可視セル優先の遅延ロードは行わない。
- 描画は Scenes の VizPanel を N 個並べず、SVG のスパークラインで自前描画する
  （48 セル × 約 200 点なら十分軽い）。Overlay も経過時間軸を扱うため同様に自前描画。
  拡大モーダルの per-GPU 表示のみ既存の `buildMetricPreviewScene`（Scenes）を再利用する。

既知の制約: ノードを複数ジョブで共有する（非 exclusive）クラスタでは、
ノード単位の切り出しに他ジョブの値が混ざる。GPU ラベルとジョブの対応が取れない限り
初版では注記表示にとどめる。

## Decisions (2026-10-08)

1. 比較ジョブ数の上限は 48。ページングなし。
2. ジョブ集合の既定は Filter モード（検索フィルタで指定）。
3. 乖離スコアは中央値プロファイルとの平均絶対差で開始。高度な統計手法は Phase 2 で検討する。
4. X 軸に Progress（0–100%）を追加する。
