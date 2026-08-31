import os from 'node:os';
import si from 'systeminformation';
import type { AgentSystemInfo, AgentSystemStats } from '@storm/types';
import type { DockerService } from './docker.service.js';

interface NetworkSample {
  rx: number;
  tx: number;
  at: number;
}

/**
 * Reports the node's hardware and live utilisation.
 *
 * Static facts are cached for a minute (they do not change while the agent
 * runs) and network counters are converted from cumulative totals into a
 * per-second rate, which is what the panel actually charts.
 */
export class SystemService {
  private cachedInfo: { value: AgentSystemInfo; at: number } | null = null;
  private lastNetwork: NetworkSample | null = null;

  constructor(
    private readonly docker: DockerService,
    private readonly dataDirectory: string,
    private readonly agentVersion: string,
  ) {}

  async info(): Promise<AgentSystemInfo> {
    if (this.cachedInfo && Date.now() - this.cachedInfo.at < 60_000) {
      return this.cachedInfo.value;
    }

    const [cpu, osInfo, disks] = await Promise.all([si.cpu(), si.osInfo(), si.fsSize()]);

    const dockerVersion = await this.docker.version().catch(() => 'unavailable');
    const mount = this.mountFor(disks);

    const value: AgentSystemInfo = {
      agentVersion: this.agentVersion,
      dockerVersion,
      kernel: osInfo.kernel,
      os: `${osInfo.distro} ${osInfo.release}`.trim(),
      architecture: osInfo.arch,
      cpuCores: cpu.physicalCores || cpu.cores || os.cpus().length,
      cpuModel: `${cpu.manufacturer} ${cpu.brand}`.trim(),
      memoryTotal: os.totalmem(),
      diskTotal: mount?.size ?? 0,
    };

    this.cachedInfo = { value, at: Date.now() };
    return value;
  }

  async stats(): Promise<AgentSystemStats> {
    const [load, memory, disks, networks, containers] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkStats(),
      this.docker.containerCounts().catch(() => ({ total: 0, running: 0 })),
    ]);

    const mount = this.mountFor(disks);

    const totals = networks.reduce(
      (acc, iface) => {
        acc.rx += iface.rx_bytes ?? 0;
        acc.tx += iface.tx_bytes ?? 0;
        return acc;
      },
      { rx: 0, tx: 0 },
    );

    const now = Date.now();
    let networkRx = 0;
    let networkTx = 0;

    if (this.lastNetwork) {
      const seconds = (now - this.lastNetwork.at) / 1000;
      if (seconds > 0) {
        // Counters reset when an interface is reconfigured; a negative delta
        // means the baseline is stale, so report zero rather than a huge spike.
        networkRx = Math.max(0, (totals.rx - this.lastNetwork.rx) / seconds);
        networkTx = Math.max(0, (totals.tx - this.lastNetwork.tx) / seconds);
      }
    }
    this.lastNetwork = { rx: totals.rx, tx: totals.tx, at: now };

    const loadAverage = os.loadavg();

    return {
      cpuPercent: Number((load.currentLoad ?? 0).toFixed(2)),
      memoryTotal: memory.total,
      // `available` accounts for reclaimable cache; `used` alone overstates it.
      memoryUsed: memory.total - (memory.available || memory.free),
      diskTotal: mount?.size ?? 0,
      diskUsed: mount?.used ?? 0,
      networkRx: Math.round(networkRx),
      networkTx: Math.round(networkTx),
      containers: containers.total,
      containersRunning: containers.running,
      loadAverage: [loadAverage[0] ?? 0, loadAverage[1] ?? 0, loadAverage[2] ?? 0],
      uptime: os.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Picks the filesystem the server data actually lives on — reporting `/`
   * would be wrong on nodes with a dedicated data volume.
   */
  private mountFor(
    disks: si.Systeminformation.FsSizeData[],
  ): si.Systeminformation.FsSizeData | undefined {
    const candidates = disks
      .filter((disk) => this.dataDirectory.startsWith(disk.mount))
      .sort((a, b) => b.mount.length - a.mount.length);

    return candidates[0] ?? disks.find((disk) => disk.mount === '/') ?? disks[0];
  }
}
