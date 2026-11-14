import { useEffect, useMemo, useState } from 'react'

import { describeState, THRESHOLD_POLICY } from '@/data/compare-engine'
import type { ComparisonItem, ComparisonReport, DrillResult } from '@/data/compare-types'

type Props = {
  report: ComparisonReport
  onDrill: (reportId: string, level: number, parentItemKey: string | null) => DrillResult | null
  onSelectReport: (reportId: string) => void
}

function valuesOf(item: ComparisonItem): string[] {
  return Array.isArray(item.dimensionValues) ? item.dimensionValues : []
}

function valueText(item: ComparisonItem, field: 'baseValue' | 'compareValue'): string {
  const value = item[field]
  if (value === null) return '—（缺失）'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function judgmentText(item: ComparisonItem): string {
  if (item.unclassified) return '未归类'
  switch (item.judgment) {
    case 'significant':
      return '显著差异'
    case 'threshold-only':
      return '超阈值（不显著）'
    case 'within-threshold':
      return '阈值内'
    default:
      return '未归类'
  }
}

export function CompareDrillPanel({ report, onDrill, onSelectReport }: Props) {
  const [level, setLevel] = useState(0)
  const [parentKey, setParentKey] = useState<string | null>(null)
  const [result, setResult] = useState<DrillResult | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setLevel(0)
    setParentKey(null)
  }, [report.id])

  useEffect(() => {
    try {
      const next = onDrill(report.id, level, parentKey)
      if (next) {
        setResult(next)
        setError('')
      } else {
        setResult(null)
        setError('下钻失败：报告或维度不存在')
      }
    } catch (err) {
      setResult(null)
      setError(err instanceof Error ? err.message : '下钻失败')
    }
    // onDrill 由父组件内联定义，按报告/层级/父级变化触发即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.id, level, parentKey])

  const children = useMemo(
    () => (result ? result.items.filter((item) => !item.unclassified) : []),
    [result],
  )
  const missing = useMemo(() => (result ? result.items.filter((item) => item.unclassified) : []), [result])

  const canDescend = level < report.dimensions.length - 1

  return (
    <section className="panel drill-panel">
      <header className="panel-head">
        <h3 className="panel-title">差异明细下钻 · v{report.version}（{describeState(report.state)}）</h3>
        <span className="muted small">
          数据快照 {result?.baselineSnapshotId ?? report.baselineSnapshotId} / {result?.comparisonSnapshotId ?? report.comparisonSnapshotId}
        </span>
      </header>
      <div className="drill-bar">
        {report.dimensions.map((dimension, index) => (
          <button
            key={`${dimension}-${index}`}
            className={index === level ? 'btn primary' : 'btn'}
            type="button"
            onClick={() => {
              setLevel(index)
              setParentKey(null)
            }}
          >
            {index + 1}. {dimension}
          </button>
        ))}
        <span className="muted small">阈值口径 {THRESHOLD_POLICY}</span>
        <button
          className="btn ghost"
          type="button"
          onClick={() => { setLevel(report.dimensions.length); setParentKey(null) }}
          title="报告快照可能缺少当前方案新增的维度"
        >
          检查更深维度
        </button>
      </div>
      {result && result.parentValues.length > 0 && (
        <p className="hint">当前路径：{result.parentValues.join(' / ')}</p>
      )}
      {result?.notice && <p className="notice ok">{result.notice}</p>}
      {error && <p className="notice error">{error}</p>}

      <table className="data-table">
        <thead>
          <tr>
            <th>维度组合</th>
            <th>指标</th>
            <th>基准合计 / 行数</th>
            <th>对照合计 / 行数</th>
            <th>相对差异</th>
            <th>z 值</th>
            <th>判定</th>
            <th>证据</th>
            <th>下钻</th>
          </tr>
        </thead>
        <tbody>
          {children.map((item) => (
            <tr key={item.key} className={item.judgment === 'significant' ? 'row-significant' : undefined}>
              <td>{valuesOf(item).map((value) => value || '（空）').join(' / ')}</td>
              <td>{item.metric}</td>
              <td>{valueText(item, 'baseValue')} <span className="muted small">/ {item.baseCount} 行</span></td>
              <td>{valueText(item, 'compareValue')} <span className="muted small">/ {item.compareCount} 行</span></td>
              <td>{item.relativeDiff === null ? '—' : `${item.relativeDiff.toFixed(2)}%`}</td>
              <td>{item.zScore === null || !Number.isFinite(item.zScore) ? (item.zScore === null ? '—' : '∞') : item.zScore.toFixed(2)}</td>
              <td><span className={`tag judgment-${item.judgment}`}>{judgmentText(item)}</span></td>
              <td className="evidence">
                {!item.evidence || item.evidence.length === 0 ? <span className="muted">—</span> : item.evidence.map((line) => <div key={line}>{line}</div>)}
              </td>
              <td>
                {canDescend ? (
                  <button className="link" type="button" onClick={() => { setLevel(level + 1); setParentKey(item.key) }}>
                    {report.dimensions[level + 1]}
                  </button>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
          {children.length === 0 && (
            <tr><td className="empty-state" colSpan={9}>该层级没有可下钻的已归类明细</td></tr>
          )}
        </tbody>
      </table>

      {(missing.length > 0 || result?.missingDimension) && (
        <>
          <h4 className="sub-title">未归类行（一侧维度缺失，不按 0 补齐、不并入已有差异）</h4>
          {missing.length === 0 && result?.missingDimensionRows && result.missingDimensionRows.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>最近一层结论</th>
                  <th>指标</th>
                  <th>基准合计 / 行数</th>
                  <th>对照合计 / 行数</th>
                  <th>判定</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {result.missingDimensionRows.map((item) => (
                  <tr key={item.key} className="row-unclassified">
                    <td>{valuesOf(item).map((value) => value || '（空）').join(' / ')}</td>
                    <td>{item.metric}</td>
                    <td>{valueText(item, 'baseValue')} <span className="muted small">/ {item.baseCount} 行</span></td>
                    <td>{valueText(item, 'compareValue')} <span className="muted small">/ {item.compareCount} 行</span></td>
                    <td>{judgmentText(item)}</td>
                    <td>报告快照缺少该下钻维度，沿用原有判定</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {missing.length === 0 && (!result?.missingDimensionRows || result.missingDimensionRows.length === 0) && (
            <p className="hint">下钻维度在报告快照中缺失，保留原有结论，不在此重算。</p>
          )}
          {missing.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>维度组合</th>
                  <th>指标</th>
                  <th>缺失侧</th>
                  <th>基准合计 / 行数</th>
                  <th>对照合计 / 行数</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {missing.map((item) => (
                  <tr key={item.key} className="row-unclassified">
                    <td>{valuesOf(item).map((value) => value || '（空）').join(' / ')}</td>
                    <td>{item.metric}</td>
                    <td>{item.missingSide === 'base' ? '基准侧' : item.missingSide === 'compare' ? '对照侧' : '指标无值'}</td>
                    <td>{valueText(item, 'baseValue')} <span className="muted small">/ {item.baseCount} 行</span></td>
                    <td>{valueText(item, 'compareValue')} <span className="muted small">/ {item.compareCount} 行</span></td>
                    <td>{item.unclassifiedReason || '指标没有有效数值'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <footer className="page-foot">
        <span>
          报告 v{report.version} · {describeState(report.state)} · 基准快照 {report.baselineSnapshotId} · 对照快照 {report.comparisonSnapshotId}
        </span>
        <button className="link" type="button" onClick={() => onSelectReport(report.id)}>固定到该报告</button>
      </footer>
    </section>
  )
}
