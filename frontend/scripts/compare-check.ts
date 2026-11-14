/**
 * 对比分析行为回归脚本（node 环境，内存版 localStorage）。
 * 运行：npx esbuild scripts/compare-check.ts --bundle --platform=node --format=cjs \
 *        --outfile=/tmp/compare-check.cjs --log-level=error && node /tmp/compare-check.cjs
 */
import {
  auditCompareWorkspace,
  currentReportForPlan,
  drillComparisonReport,
  generateComparisonReport,
  inspectCompareWorkspace,
  listComparisonReports,
  publishComparisonReport,
  revokeComparisonReport,
  setComparisonPlanEnabled,
  updateComparisonPlan,
} from '../src/data/compare-service'
import { relativeDiffOf } from '../src/data/compare-engine'
import { plans, reports, resetWorkspace, saveReports } from '../src/data/compare-workspace'

function memStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage
}

;(globalThis as any).window = { localStorage: memStorage() }

let failures = 0
function check(label: string, condition: boolean, extra?: unknown) {
  if (!condition) {
    failures += 1
    console.error('FAIL', label, extra ?? '')
  } else {
    console.log('ok  ', label)
  }
}

resetWorkspace()

// ── 1. 首次生成：全量扫描、自动发布（已启用方案）、记录快照、缺失组单列 ──
const first = generateComparisonReport(1)
check('初次生成成功', first.ok, first.message)
check('初次为全量扫描', first.detail?.fullScan === true)
check('初次自动发布', first.report?.state === 'published', first.report?.state)
const v1 = first.report!
check('初始报告记录基准快照', v1.baselineSnapshotId === 'snap-2026-10-base', v1.baselineSnapshotId)
check('缺失组单列未归类行', v1.items.some((item) => item.unclassified), v1.summary)
check(
  '未按零补齐：缺失侧值为 null',
  v1.items.filter((i) => i.unclassified).every((i) => i.baseValue === null || i.compareValue === null),
)

// ── 2. 只调阈值：复用未变化切片，仅重算临界附近 ──
const bumped = updateComparisonPlan(1, { threshold: 18 })
check('调阈值成功', bumped.ok, bumped.message)
const v2 = bumped.generated!
check('调阈值生成候选（已有发布版）', v2.state === 'candidate', v2.state)
check('调阈值不全量扫描', v2.scan.fullScan === false)
check('调阈值复用切片', v2.scan.reusedSlices > 0, v2.scan)
check('调阈值只重算部分切片', v2.scan.recomputedSlices > 0 && v2.scan.recomputedSlices < v1.summary.sliceCount, v2.scan)
check('切片总数覆盖全部', v2.scan.reusedSlices + v2.scan.recomputedSlices === v1.summary.sliceCount, v2.scan)
check('旧发布报告未被覆盖', reports().find((r) => r.id === v1.id)?.state === 'published')
check('旧报告判定未改写', JSON.stringify(reports().find((r) => r.id === v1.id)?.items) === JSON.stringify(v1.items))
check('候选不挤掉当前口径', currentReportForPlan(1)?.id === v1.id)
// 独立复算预期集合：判定翻转（10% ↔ 18%）或落在新旧阈值任一临界带，且非显著、非缺失。
const expectedRecompute = new Set(
  v1.items
    .filter((item) => {
      if (item.unclassified || item.significant) return false
      if (item.relativeDiff === null) return false
      const magnitude = Math.abs(item.relativeDiff)
      const flipped = (magnitude > 10) !== (magnitude > 18)
      const inBand = (magnitude >= 10 * 0.8 && magnitude <= 10 * 1.2) || (magnitude >= 18 * 0.8 && magnitude <= 18 * 1.2)
      return flipped || inBand
    })
    .map((item) => item.key),
)
const actualRecompute = new Set(v2.items.filter((i) => i.judgmentRecomputed).map((i) => i.key))
check(
  '重算集合与独立复算一致（临界带/翻转切片）',
  actualRecompute.size === expectedRecompute.size && [...actualRecompute].every((key) => expectedRecompute.has(key)),
  { actual: actualRecompute.size, expected: expectedRecompute.size },
)
check('显著切片不因阈值变化重算', v2.items.filter((i) => i.significant).every((i) => !i.judgmentRecomputed))
check('未重算切片沿用旧阈值判定标记', v2.items.filter((i) => !i.judgmentRecomputed).every((i) => i.thresholdExceeded === (i.relativeDiff === null ? null : Math.abs(i.relativeDiff) > 18)))

// ── 3. 发布候选：新旧版本并存，旧报告仍可下钻 ──
check('候选发布成功', publishComparisonReport(v2.id).ok)
check('发布后当前口径指向新版本', currentReportForPlan(1)?.id === v2.id)
check('旧发布版本仍可下钻', drillComparisonReport(v1.id, 1).ok)

// ── 4. 显著性水平变化：生成新判定版本、复用数据、记录新 α ──
const sig = updateComparisonPlan(1, { significance: 0.01 })
check('显著性变化生成新候选', sig.generated?.state === 'candidate')
check('显著性变化原因正确', sig.generated?.reason === 'significance', sig.generated?.reason)
const v3 = sig.generated!
check('显著性重算全部判定', v3.scan.recomputedSlices > 0)
check('显著性变化仍复用数据', v3.scan.fullScan === false, v3.scan)
check('明细记录新显著性', v3.items.every((item) => item.evaluatedSignificance === 0.01))

// ── 5. 维度顺序/大小写差异不产生虚假新增 ──
const cosmetic = updateComparisonPlan(1, { dimensionsRaw: 'Category,REGION,Channel' })
check('仅顺序/大小写变化不生成新版本', cosmetic.generated === null, cosmetic.message)
check('cosmeticOnly 标记', cosmetic.cosmeticOnly === true)
const countBefore = listComparisonReports(1).length
updateComparisonPlan(1, { dimensionsRaw: 'category, region, channel' })
check('恢复顺序也不生成新版本', listComparisonReports(1).length === countBefore)
const reordered = updateComparisonPlan(1, { dimensionsRaw: 'category, region, channel', threshold: 12 })
const leafKeysOf = (items: NonNullable<typeof reordered.generated>['items']) =>
  new Set(items.filter((i) => i.level === 2).map((i) => i.key))
const reorderedKeys = leafKeysOf(reordered.generated!.items)
const baselineKeys = leafKeysOf(v2.items)
check('重排后明细键集合不变（无虚假新增）', reorderedKeys.size === baselineKeys.size, [reorderedKeys.size, baselineKeys.size])
check('明细键不携带大小写差异', [...reorderedKeys].every((key) => !/[A-Z]/.test(key)))
check('重排后层级仍完整', new Set(reordered.generated!.items.map((i) => i.level)).size === 3)

// 纯大小写变化（规范化后顺序一致）：不生成新版本，已有报告继续引用
const plan2Case = updateComparisonPlan(2, { dimensionsRaw: 'REGION, category' })
check('纯大小写变化不生成新版本', plan2Case.generated === null, plan2Case.message)
check('大小写变化后方案顺序已规范化', plan2Case.plan?.dimensions.join('|') === 'Region|Category', plan2Case.plan?.dimensions)

// ── 6. 同一时刻多个方案切换阈值：互不挤掉，停用方案只出候选 ──
const plan4First = generateComparisonReport(4)
check('停用方案首次生成只候选', plan4First.report?.state === 'candidate', plan4First.report?.state)
updateComparisonPlan(1, { threshold: 9 })
updateComparisonPlan(4, { threshold: 7 })
check(
  '方案 1 的已发布报告未被其他方案挤掉',
  listComparisonReports(1).filter((r) => r.state === 'published' && !r.supersededAt).length === 1,
)
check('方案 4 没有发布版本', listComparisonReports(4).filter((r) => r.state === 'published').length === 0)
check('停用方案无法发布', publishComparisonReport(plan4First.report!.id).ok === false)
check('停用方案旧候选仍可下钻', drillComparisonReport(plan4First.report!.id, 1).ok)

// ── 7. 撤销后重新生成：快照可核对，撤销报告仍可下钻 ──
const revokeTarget = listComparisonReports(1).find((r) => r.state === 'published')!
check('撤销成功', revokeComparisonReport(revokeTarget.id).ok)
check('撤销后明细仍可下钻', drillComparisonReport(revokeTarget.id, 0).ok)
const regen = generateComparisonReport(1, { forceFullScan: true })
check('重新生成沿用同一基准快照', regen.report?.baselineSnapshotId === revokeTarget.baselineSnapshotId, regen.report?.baselineSnapshotId)
check('撤销后重新生成全量重建', regen.detail?.fullScan === true)
check('撤销后不自动发布', regen.report?.state === 'candidate')

// ── 8. 停用方案：旧报告可下钻，新阈值只能候选 ──
setComparisonPlanEnabled(1, false)
const disabledGenerated = updateComparisonPlan(1, { threshold: 30 })
check('停用方案修改阈值只生成候选', disabledGenerated.generated?.state === 'candidate', disabledGenerated.generated?.state)
check('停用方案旧报告仍可下钻', drillComparisonReport(revokeTarget.id, 0).ok)
check('停用方案禁止发布', publishComparisonReport(disabledGenerated.generated!.id).ok === false)
check('停用方案旧发布报告仍为当前口径', currentReportForPlan(1)?.state === 'published')

// ── 9. 同一维度类型不同：阻止误比较 ──
const mismatch = generateComparisonReport(3)
check('类型不一致被阻止', mismatch.ok === false && /口径不一致/.test(mismatch.message), mismatch.message)

// ── 10. 重复执行：明细键唯一、缺失组不被并入已有差异 ──
const repeatA = generateComparisonReport(1, { forceFullScan: true })
const repeatB = generateComparisonReport(1, { forceFullScan: true })
check('重复执行明细键唯一', new Set(repeatA.report!.items.map((i) => i.key)).size === repeatA.report!.items.length)
check(
  '两次执行键集合一致',
  JSON.stringify([...new Set(repeatA.report!.items.map((i) => i.key))].sort()) ===
    JSON.stringify([...new Set(repeatB.report!.items.map((i) => i.key))].sort()),
)
const missingAfterRepeat = repeatA.report!.items.filter((i) => i.unclassified)
check('缺失组始终独立成行', missingAfterRepeat.every((i) => i.missingSide !== null))
check('缺失组键在同层唯一', new Set(missingAfterRepeat.map((i) => i.key)).size === missingAfterRepeat.length)

// ── 11. 下钻：按父级过滤、缺失维度显示未归类行且不重算 ──
const level0 = drillComparisonReport(repeatA.report!.id, 0)
check('首层下钻成功', level0.ok && level0.result!.items.length > 0)
const parent = level0.result!.items.find((i) => !i.unclassified)!
const level1 = drillComparisonReport(repeatA.report!.id, 1, parent.key)
check('二层按父级过滤', level1.result!.items.every((i) => i.parentHierarchyKey === parent.hierarchyKey))
check('二层继承父级维度值', level1.result!.parentValues.length === 1)
const deep = drillComparisonReport(repeatA.report!.id, 99)
check('缺失层级有提示', deep.result?.missingDimension === true)
check('缺失维度展示未归类行', (deep.result?.missingDimensionRows.length ?? 0) > 0)
check(
  '缺失维度不重算旧结论',
  JSON.stringify(deep.result?.report.items) ===
    JSON.stringify(reports().find((r) => r.id === repeatA.report!.id)?.items),
)
check('未归类行键来自原报告', deep.result!.missingDimensionRows.every((row) => repeatA.report!.items.some((i) => i.key === row.key)))

// ── 12. 故障注入：重复明细、残留旧阈值、缺字段、双发布 → 体检 + 清理 ──
const raw = reports()
const victim = raw.find((r) => r.planId === 1 && r.state === 'published')!
const broken: any = JSON.parse(JSON.stringify(victim))
delete broken.scan
delete broken.summary
broken.items = [...broken.items, { ...broken.items[0] }]
broken.items[1] = { ...(broken.items[1] ?? broken.items[0]), evaluatedThreshold: 999 }
delete broken.items[2].key
delete broken.items[2].hierarchyKey
const secondPublished = {
  ...JSON.parse(JSON.stringify(victim)),
  id: 'dup-published',
  version: victim.version + 50,
  state: 'published' as const,
  publishedAt: victim.publishedAt,
}
saveReports([...raw.map((r) => (r.id === victim.id ? broken : r)), secondPublished])
const health = inspectCompareWorkspace()
check('体检发现重复明细', health.duplicateItems > 0, health)
check('体检发现残留旧阈值', health.staleItems > 0, health)
check('体检发现缺失字段', health.missingFields > 0, health)
check('体检发现发布冲突', health.publishedConflicts > 0, health)
const cleaned = auditCompareWorkspace()
check('清理执行成功', cleaned.ok)
check('清理后无重复', inspectCompareWorkspace().duplicateItems === 0, inspectCompareWorkspace())
check('清理后无残留', inspectCompareWorkspace().staleItems === 0, inspectCompareWorkspace())
check('清理后无发布冲突', inspectCompareWorkspace().publishedConflicts === 0, inspectCompareWorkspace())
check('清理后原报告仍可下钻', drillComparisonReport(victim.id, 1).ok)
check('清理保留历史发布版本', reports().filter((r) => r.planId === 1 && r.supersededAt).length >= 1)
const cleanedTwice = auditCompareWorkspace()
check('清理可重复执行（幂等）', cleanedTwice.duplicateItemsRemoved === 0 && cleanedTwice.staleItemsRemoved === 0, cleanedTwice)

// ── 13. 撤销当前发布后：当前口径回落到上一份可读的发布版本 ──
setComparisonPlanEnabled(1, true)
const fresh = generateComparisonReport(1).report!
publishComparisonReport(fresh.id)
const beforeRevoke = currentReportForPlan(1)!
check('发布后当前口径为发布版本', beforeRevoke.state === 'published' && beforeRevoke.id === fresh.id)
revokeComparisonReport(beforeRevoke.id)
const fallback = currentReportForPlan(1)
check('撤销后回落到可读的历史发布版本', fallback !== null && fallback.id !== beforeRevoke.id, fallback?.id)
if (fallback) check('回落版本仍可下钻', drillComparisonReport(fallback.id, 0).ok)

// ── 14. 阈值口径与持久化 ──
check('相对差异口径为百分比', relativeDiffOf(100, 120) === 20)
check('阈值口径常量落库', reports().every((r) => r.thresholdPolicy === 'relative-percent'))
const storage = (globalThis as any).window.localStorage as Storage
check('报告已持久化到本地', Boolean(storage.getItem('interactive-analytics-lab:compare-workspace')))
check('方案清单可读', plans().length === 4, plans().length)

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
