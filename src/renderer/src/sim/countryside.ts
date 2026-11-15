// 土地の配置は固定し、農道だけを地形に合わせて探索する。描画に依存しない。
import { gradientNoise, type Terrain } from './terrain'
import type { PlotResult } from './plots'
import { random, type Tree } from './trees'

export interface FarmRoad {
  /** false: x に沿って進む。true: z に沿って進む */
  vertical: boolean
  offsets: Float32Array
}

export interface Countryside {
  trees: Tree[]
  roads: FarmRoad[]
  /** 土地 ID。農道・畦・外周は -1 */
  parcels: Int32Array
  /** 描画用 RGBA。赤は土地の色調、緑は畦、青は農道 */
  surface: Uint8Array
  /** 樹木の幹や茂みのまわりで、機械が通れない所を 1 にした格子 */
  blocked: Uint8Array
}

const EDGE = 230
const STEP = 4
const COUNT = EDGE * 2 / STEP + 1

/**
 * 両端を結ぶ農道。距離、縦断勾配、横断勾配、予定線からの距離を評価する。
 * 横方向に 2 m 刻みの候補を置く動的計画法。過大な遠回りを避けるため帯状に探索する。
 */
function road(terrain: Terrain, vertical: boolean, offset: number): FarmRoad {
  const width = 41
  const middle = 20
  const parents = new Int16Array(COUNT * width)
  let costs = new Float64Array(width).fill(Infinity)
  costs[middle] = 0
  const height = (s: number, t: number): number => vertical ? terrain.heightAt(t, s) : terrain.heightAt(s, t)
  for (let k = 1; k < COUNT; k++) {
    const next = new Float64Array(width).fill(Infinity)
    const s = -EDGE + k * STEP
    for (let j = 0; j < width; j++) {
      if (k === COUNT - 1 && j !== middle) continue
      const t = offset + (j - middle) * 2
      const cross = (height(s, t + 2) - height(s, t - 2)) / 4
      for (let p = Math.max(0, j - 1); p <= Math.min(width - 1, j + 1); p++) {
        const distance = Math.hypot(STEP, (j - p) * 2)
        const grade = (height(s, t) - height(s - STEP, offset + (p - middle) * 2)) / distance
        const cost = costs[p] + distance * (1 + 95 * grade * grade + 8 * cross * cross + 0.0003 * (t - offset) ** 2)
        if (cost < next[j]) {
          next[j] = cost
          parents[k * width + j] = p
        }
      }
    }
    costs = next
  }
  const raw = new Float32Array(COUNT)
  let j = middle
  for (let k = COUNT - 1; k >= 0; k--) {
    raw[k] = offset + (j - middle) * 2
    j = parents[k * width + j]
  }
  // 探索格子の折れを局所的にならす。両端は入口として固定する。
  const offsets = raw.map((_, k) => {
    if (k === 0 || k === COUNT - 1) return offset
    let sum = 0
    for (let d = -3; d <= 3; d++) sum += raw[Math.max(0, Math.min(COUNT - 1, k + d))]
    return sum / 7
  })
  return { vertical, offsets }
}

export function roadOffset(road: FarmRoad, s: number): number {
  const u = Math.max(0, Math.min(COUNT - 1, (s + EDGE) / STEP))
  const k = Math.min(COUNT - 2, Math.floor(u))
  return road.offsets[k] + (road.offsets[k + 1] - road.offsets[k]) * (u - k)
}

export function createCountryside(terrain: Terrain): Countryside {
  const roads = [road(terrain, false, -20), ...[-115, 15, 135].map((x) => road(terrain, true, x))]
  const n = terrain.samples
  const parcels = new Int32Array(n * n).fill(-1)
  const surface = new Uint8Array(n * n * 4)
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = terrain.origin + ix * terrain.options.cell
      const z = terrain.origin + iz * terrain.options.cell
      const i = iz * n + ix
      surface[i * 4 + 3] = 255
      if (Math.abs(x) > EDGE || Math.abs(z) > EDGE) continue
      let distance = Infinity
      for (const r of roads) distance = Math.min(distance, Math.abs((r.vertical ? x : z) - roadOffset(r, r.vertical ? z : x)))
      const column = roads.slice(1).filter((r) => x > roadOffset(r, z)).length
      const id = column + (z > roadOffset(roads[0], x) ? 4 : 0)
      const border = Math.min(EDGE - Math.abs(x), EDGE - Math.abs(z))
      if (distance > 5 && border > 3) parcels[i] = id
      surface[i * 4] = 30 + id * 28
      surface[i * 4 + 1] = distance > 3.2 && distance < 5.2 || border < 3 ? 255 : 0
      surface[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, 3.7 - distance)) * 255)
    }
  }
  const blocked = new Uint8Array(n * n)
  const trees = plantCountryside(terrain, roads, parcels, blocked)
  return { roads, parcels, surface, trees, blocked }
}

/** 道の中心線までの水平距離(m)。いちばん近い道について返す */
function roadDistance(roads: FarmRoad[], x: number, z: number): number {
  let distance = Infinity
  for (const r of roads) distance = Math.min(distance, Math.abs((r.vertical ? x : z) - roadOffset(r, r.vertical ? z : x)))
  return distance
}

/**
 * 田園の樹木と低木。参考はトスカーナの丘陵(糸杉の並木、道沿いの茂み、窪地の雑木林、畑の外の林)。
 * 木のまわりは土地から外し(作業しない)、通れない格子にも印を付ける。
 * 配置は地形のシード値で決まる。
 */
function plantCountryside(terrain: Terrain, roads: FarmRoad[], parcels: Int32Array, blocked: Uint8Array): Tree[] {
  const seed = terrain.options.seed
  const next = random(seed * 4271 + 91)
  const n = terrain.samples
  const cell = terrain.options.cell
  const trees: Tree[] = []
  const near = (x: number, z: number, gap: number): boolean =>
    trees.some((t) => Math.abs(t.x - x) < gap && Math.abs(t.z - z) < gap && Math.hypot(t.x - x, t.z - z) < gap)
  /** 木を植え、幹(茂み)から clearance m までを作業と通行から外す */
  const plant = (tree: Tree, clearance: number): void => {
    trees.push(tree)
    const cx = Math.round((tree.x - terrain.origin) / cell)
    const cz = Math.round((tree.z - terrain.origin) / cell)
    const radius = Math.ceil(clearance / cell)
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const ix = cx + dx
        const iz = cz + dz
        if (ix < 0 || iz < 0 || ix >= n || iz >= n || Math.hypot(dx, dz) * cell > clearance) continue
        parcels[iz * n + ix] = -1
        blocked[iz * n + ix] = 1
      }
    }
  }
  const atCrossing = (x: number, z: number, except: FarmRoad): boolean =>
    roads.some((r) => r !== except && Math.abs((r.vertical ? x : z) - roadOffset(r, r.vertical ? z : x)) < 12)
  const broadleaf = (x: number, z: number, scale: number, lone: boolean): Tree => {
    const height = (8 + next() * 6) * scale
    return { kind: 'broadleaf', x, z, height, spread: height * (0.3 + next() * 0.1), tone: next(), lone }
  }
  const shrub = (x: number, z: number): Tree => {
    const height = 1.6 + next() * 1.8
    return { kind: 'shrub', x, z, height, spread: height * 0.65, tone: next(), lone: false }
  }

  // 1. 主道沿いの糸杉。交差点は空ける。
  const main = roads[0]
  for (let x = -195; x <= 195; x += 26) {
    const z = roadOffset(main, x) + 7
    if (atCrossing(x, z, main)) continue
    plant({ kind: 'conifer', x, z, height: 9 + 2 * Math.sin(x), spread: 1.3, tone: 0.4, lone: true }, 3)
  }

  // 2. 糸杉の並木。中央の横断道の北半分の両側に、詰めて並べる(丘の上の家へ続く道のような景色)。
  const avenue = roads[2]
  for (let z = roadOffset(main, roadOffset(avenue, 0)) + 16; z <= 205; z += 8.5) {
    const x0 = roadOffset(avenue, z)
    for (const side of [-1, 1]) {
      const x = x0 + side * 6.8
      plant({ kind: 'conifer', x, z, height: 10 + next() * 3.5, spread: 1.1 + next() * 0.35, tone: 0.3 + next() * 0.3, lone: false }, 2.4)
    }
  }

  // 3. 道沿いの茂み。畦に低木を連ね、ところどころに広葉樹を混ぜる。途切れ途切れにする。
  for (const r of roads) {
    for (const side of [-1, 1]) {
      for (let s = -222; s <= 222; s += 2.3) {
        // 道に沿ったノイズで、茂みの続く所と途切れる所を決める
        if (gradientNoise(s / 38 + side * 7, roads.indexOf(r) * 5.3, seed + 211) < -0.15) continue
        const t = roadOffset(r, s) + side * (4.3 + (next() - 0.5) * 0.8)
        const x = r.vertical ? t : s + (next() - 0.5)
        const z = r.vertical ? s + (next() - 0.5) : t
        if (atCrossing(x, z, r) || near(x, z, 2.6)) continue
        if (next() < 0.13) {
          if (!near(x, z, 7)) plant(broadleaf(x, z, 0.85, false), 3.2)
        } else {
          plant(shrub(x, z), 1.7)
        }
      }
    }
  }

  // 4. 窪地の雑木林。まわりより低い所を探し、広葉樹のかたまりと縁の低木を置く。
  const hollows: { x: number; z: number; depth: number }[] = []
  for (let z = -200; z <= 200; z += 10) {
    for (let x = -200; x <= 200; x += 10) {
      const h = terrain.heightAt(x, z)
      let around = 0
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2
        around += terrain.heightAt(x + Math.cos(a) * 28, z + Math.sin(a) * 28)
      }
      const depth = around / 8 - h
      // 道の上や道のすぐ脇は避ける(道を林で塞がない)
      if (depth > 0.08 && roadDistance(roads, x, z) > 16) hollows.push({ x, z, depth })
    }
  }
  hollows.sort((a, b) => b.depth - a.depth)
  const copses: { x: number; z: number }[] = []
  for (const h of hollows) {
    if (copses.length >= 12) break
    if (copses.some((c) => Math.hypot(c.x - h.x, c.z - h.z) < 55)) continue
    copses.push(h)
  }
  for (const c of copses) {
    const radius = 11 + next() * 10
    for (let k = 0; k < radius * radius * 0.16; k++) {
      const a = next() * Math.PI * 2
      const d = radius * Math.sqrt(next())
      const x = c.x + Math.cos(a) * d
      const z = c.z + Math.sin(a) * d
      if (roadDistance(roads, x, z) < 9 || near(x, z, 4.2)) continue
      plant(broadleaf(x, z, 1, false), 4)
    }
    for (let k = 0; k < radius * 2.2; k++) {
      const a = next() * Math.PI * 2
      const d = radius + 1 + next() * 3
      const x = c.x + Math.cos(a) * d
      const z = c.z + Math.sin(a) * d
      if (roadDistance(roads, x, z) < 6 || near(x, z, 2.2)) continue
      plant(shrub(x, z), 1.8)
    }
  }

  // 5. 畑の中の一本立ちの大きな木。道から少し入った所に、ほかの木から離して立てる。
  let placed = 0
  for (let tries = 0; tries < 400 && placed < 8; tries++) {
    const x = (next() - 0.5) * 380
    const z = (next() - 0.5) * 380
    const d = roadDistance(roads, x, z)
    if (d < 12 || d > 40 || near(x, z, 45)) continue
    plant(broadleaf(x, z, 1.25, true), 4)
    placed++
  }

  // 6. 畑の外の林。ノイズでまとまりを作り、縁に低木を茂らせる。遠いほど間引く。
  const spacing = 7.5
  const outer = 520
  for (let gz = -outer; gz <= outer; gz += spacing) {
    for (let gx = -outer; gx <= outer; gx += spacing) {
      const x = gx + (next() - 0.5) * spacing * 0.8
      const z = gz + (next() - 0.5) * spacing * 0.8
      const keep = next()
      const border = Math.max(Math.abs(x), Math.abs(z))
      const r = Math.hypot(x, z)
      if (border < EDGE + 10 || r > outer) continue
      const density = gradientNoise(x / 95 + 11, z / 95 - 4, seed + 307)
      if (density < 0.08) continue
      if (r > 380 && keep < 0.5) continue
      if (density < 0.16) {
        // 林の縁は低木
        if (r < 330 && keep < 0.6) plant(shrub(x, z), 1.7)
        continue
      }
      if (gradientNoise(x / 60 - 2, z / 60 + 6, seed + 509) > 0.2) {
        const height = 11 + next() * 8
        plant({ kind: 'conifer', x, z, height, spread: height * (0.16 + next() * 0.05), tone: next(), lone: false }, 2.5)
      } else {
        plant(broadleaf(x, z, 1.05, false), 2.5)
      }
    }
  }
  return trees
}

/** 土地境界を維持し、到達可能な部分を連結成分ごとに作業区画へ変換する。 */
export function countrysidePlots(farm: Countryside, reach: Uint8Array, n: number, cell: number): PlotResult {
  const labels = new Int32Array(reach.length).fill(-1)
  const plots: PlotResult['plots'] = []
  const queue = new Int32Array(reach.length)
  for (let i = 0; i < reach.length; i++) {
    if (!reach[i] || farm.parcels[i] < 0 || labels[i] !== -1) continue
    const id = plots.length
    let head = 0, tail = 1, sx = 0, sz = 0
    queue[0] = i
    labels[i] = id
    while (head < tail) {
      const p = queue[head++]
      const x = p % n, z = Math.floor(p / n)
      sx += x
      sz += z
      const neighbors = [x > 0 ? p - 1 : -1, x < n - 1 ? p + 1 : -1, z > 0 ? p - n : -1, z < n - 1 ? p + n : -1]
      for (const q of neighbors) {
        if (q < 0 || !reach[q] || labels[q] !== -1 || farm.parcels[q] !== farm.parcels[i]) continue
        labels[q] = id
        queue[tail++] = q
      }
    }
    // 幹と畦の間や、木と茂みの間など、機体の作業場所にならない切れ端は残さない。
    if (tail * cell * cell < 200) {
      for (let k = 0; k < tail; k++) labels[queue[k]] = -2
    } else {
      plots.push({ id, area: tail * cell * cell, centerX: sx / tail, centerZ: sz / tail })
    }
  }
  for (let i = 0; i < labels.length; i++) if (labels[i] === -2) labels[i] = -1
  return { samples: n, labels, plots }
}
