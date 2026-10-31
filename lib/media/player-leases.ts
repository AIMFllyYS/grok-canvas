/**
 * 播放器租约（P4-03）：全局最多 2 个挂载的 <video>，最多 1 个在播放。
 * - 视频节点默认只显示 poster，用户主动点播放才申请租约；
 * - 第 3 个申请时释放最久未用的暂停实例（通知它卸载 src），不会同时挂三个 video；
 * - 开始播放会暂停另一个正在播放的实例；
 * - 释放幂等；离屏/隐藏由调用方 release，回到视口不自动播放。
 */
export type PlayerCallbacks = { evict: () => void; pause: () => void };
type Lease = { nodeId: string; callbacks: PlayerCallbacks; playing: boolean; usedAt: number; released: boolean };

export const PLAYER_LIMITS = { instances: 2, playing: 1 };

export function createPlayerLeases(limits = PLAYER_LIMITS) {
  const leases: Lease[] = [];
  let clock = 0;
  const peak = { instances: 0, playing: 0 };
  const playingCount = () => leases.filter(l => l.playing).length;

  function drop(lease: Lease) {
    if (lease.released) return;
    lease.released = true;
    lease.playing = false;
    const index = leases.indexOf(lease);
    if (index >= 0) leases.splice(index, 1);
  }

  return {
    acquire(nodeId: string, callbacks: PlayerCallbacks) {
      const existing = leases.find(l => l.nodeId === nodeId && !l.released);
      if (existing) { existing.callbacks = callbacks; existing.usedAt = ++clock; }
      let lease = existing;
      if (!lease) {
        while (leases.length >= limits.instances) {
          // 优先释放暂停的最旧实例；全都在播放时释放最旧的那个（先暂停再卸载）。
          const victim = [...leases].sort((a, b) => Number(a.playing) - Number(b.playing) || a.usedAt - b.usedAt)[0]!;
          if (victim.playing) victim.callbacks.pause();
          drop(victim);
          victim.callbacks.evict();
        }
        lease = { nodeId, callbacks, playing: false, usedAt: ++clock, released: false };
        leases.push(lease);
      }
      peak.instances = Math.max(peak.instances, leases.length);
      const own = lease;
      return {
        nodeId,
        /** 开始播放：超过同时播放上限时暂停其他实例。 */
        play() {
          if (own.released) return false;
          for (const other of leases) if (other !== own && other.playing && playingCount() >= limits.playing) { other.playing = false; other.callbacks.pause(); }
          own.playing = true;
          own.usedAt = ++clock;
          peak.playing = Math.max(peak.playing, playingCount());
          return true;
        },
        paused() { own.playing = false; },
        release() { drop(own); },
        active: () => !own.released,
      };
    },
    stats: () => ({ instances: leases.length, playing: playingCount(), peak: { ...peak } }),
  };
}

export type PlayerLeases = ReturnType<typeof createPlayerLeases>;
export type PlayerLease = ReturnType<PlayerLeases["acquire"]>;
