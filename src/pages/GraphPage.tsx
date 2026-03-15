import React, {
  useRef,
  useState,
  useEffect,
  useMemo,
  useCallback,
  type MutableRefObject,
} from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Stars } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { EffectComposer, Bloom, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import * as THREE from "three";
import {
  reddit,
  auth,
  post as postApi,
  getSavedSubreddits,
  saveSubreddits,
  type RedditComment,
  type RedditUser,
} from "../api";

// ── Error Boundary ────────────────────────────────────────────────────

class GraphErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "#08080c",
            color: "#a1a1aa",
            gap: "1rem",
          }}
        >
          <p>3D renderer crashed.</p>
          <button
            onClick={() => this.setState({ hasError: false })}
            style={{
              padding: "0.5rem 1.25rem",
              borderRadius: "6px",
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(255,255,255,0.06)",
              color: "#e4e4e7",
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Palette ───────────────────────────────────────────────────────────

const PAL = {
  sub: "#8b5cf6",
  subEmit: "#6366f1",
  post: "#06b6d4",
  postEmit: "#0891b2",
  comment: "#f59e0b",
  commentEmit: "#d97706",
  edge: "#3f3f46",
  pingNew: "#22c55e",
  bg: "#08080c",
};

// ── Force simulation parameters ───────────────────────────────────────

const SIM = {
  repulsion: 40,
  minDist: 4,
  spring: 0.06,
  restLen: { sub: 10, post: 7 },
  centerPull: 0.005,
  yBias: 0.05,
  yLevels: { subreddit: 0, post: -10, comment: -18 } as Record<string, number>,
  damping: 0.75,
  maxSpeed: 1.5,
  mass: { subreddit: 3, post: 1.5, comment: 0.8 } as Record<string, number>,
};

// ── Types ─────────────────────────────────────────────────────────────

interface SimNode {
  id: string;
  type: "subreddit" | "post" | "comment";
  parentId: string | null;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  mass: number;
}

interface SimState {
  nodes: Map<string, SimNode>;
  edges: { source: string; target: string; rest: number }[];
}

interface GNodeData {
  id: string;
  type: "subreddit" | "post" | "comment";
  label: string;
  parentId: string | null;
  subName: string | null;
  postId: string | null;
  permalink: string | null;
  score: number | null;
}

interface GraphPost {
  key: string;
  redditId: string;
  title: string;
  subreddit: string;
  author: string;
  score: number;
  numComments: number;
  permalink: string;
  selftext: string;
  url: string;
  isSelf: boolean;
  imageUrl: string | null;
  videoUrl: string | null;
  galleryUrls: string[];
}

interface Ping {
  id: string;
  nodeId: string;
  birth: number;
}

// ── Helpers ───────────────────────────────────────────────────────────

function truncate(s: string, len: number) {
  return s.length > len ? s.slice(0, len - 1) + "\u2026" : s;
}

function jitter(range: number) {
  return (Math.random() - 0.5) * range;
}

// ── Simulation logic ──────────────────────────────────────────────────

function syncSim(sim: SimState, nodes: GNodeData[]) {
  const wanted = new Set(nodes.map((n) => n.id));

  for (const id of sim.nodes.keys()) {
    if (!wanted.has(id)) sim.nodes.delete(id);
  }

  let rootCount = 0;
  for (const sn of sim.nodes.values()) {
    if (!sn.parentId) rootCount++;
  }

  for (const n of nodes) {
    if (sim.nodes.has(n.id)) continue;
    const yTarget = SIM.yLevels[n.type] ?? 0;

    if (n.parentId && sim.nodes.has(n.parentId)) {
      const p = sim.nodes.get(n.parentId)!;
      const rest = n.type === "comment" ? SIM.restLen.post : SIM.restLen.sub;
      const angle = Math.random() * Math.PI * 2;
      const tilt = (Math.random() - 0.5) * 0.6;
      sim.nodes.set(n.id, {
        id: n.id,
        type: n.type,
        parentId: n.parentId,
        x: p.x + Math.cos(angle) * rest * (0.7 + Math.random() * 0.6),
        y: yTarget + jitter(2),
        z: p.z + Math.sin(angle) * rest * (0.7 + Math.random() * 0.6),
        vx: 0,
        vy: tilt,
        vz: 0,
        mass: SIM.mass[n.type] ?? 1,
      });
    } else {
      const radius = 12 + rootCount * 3;
      const angle = rootCount * 2.399 + jitter(0.3);
      rootCount++;
      sim.nodes.set(n.id, {
        id: n.id,
        type: n.type,
        parentId: n.parentId,
        x: Math.cos(angle) * radius,
        y: yTarget + jitter(1),
        z: Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        vz: 0,
        mass: SIM.mass[n.type] ?? 1,
      });
    }
  }

  sim.edges = [];
  for (const n of nodes) {
    if (n.parentId && sim.nodes.has(n.parentId)) {
      const rest = n.type === "comment" ? SIM.restLen.post : SIM.restLen.sub;
      sim.edges.push({ source: n.parentId, target: n.id, rest });
    }
  }
}

function stepSim(sim: SimState) {
  const nodes = Array.from(sim.nodes.values());
  const n = nodes.length;
  if (n === 0) return;

  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const fz = new Float64Array(n);
  const idx = new Map<string, number>();
  nodes.forEach((nd, i) => idx.set(nd.id, i));

  // Repulsion
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let dx = nodes[j].x - nodes[i].x;
      let dy = nodes[j].y - nodes[i].y;
      let dz = nodes[j].z - nodes[i].z;
      let distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < 0.001) {
        dx = (Math.random() - 0.5) * 0.1;
        dy = (Math.random() - 0.5) * 0.1;
        dz = (Math.random() - 0.5) * 0.1;
        distSq = dx * dx + dy * dy + dz * dz;
      }
      let dist = Math.sqrt(distSq);
      if (dist < SIM.minDist) dist = SIM.minDist;
      const strength =
        (SIM.repulsion * nodes[i].mass * nodes[j].mass) / (dist * dist);
      const invDist = 1 / dist;
      fx[i] -= strength * dx * invDist;
      fy[i] -= strength * dy * invDist;
      fz[i] -= strength * dz * invDist;
      fx[j] += strength * dx * invDist;
      fy[j] += strength * dy * invDist;
      fz[j] += strength * dz * invDist;
    }
  }

  // Springs
  for (const e of sim.edges) {
    const si = idx.get(e.source);
    const ti = idx.get(e.target);
    if (si === undefined || ti === undefined) continue;
    const s = nodes[si];
    const t = nodes[ti];
    let dx = t.x - s.x;
    let dy = t.y - s.y;
    let dz = t.z - s.z;
    let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 0.01) dist = 0.01;
    const displacement = dist - e.rest;
    const force = SIM.spring * displacement;
    const invDist = 1 / dist;
    fx[si] += force * dx * invDist;
    fy[si] += force * dy * invDist;
    fz[si] += force * dz * invDist;
    fx[ti] -= force * dx * invDist;
    fy[ti] -= force * dy * invDist;
    fz[ti] -= force * dz * invDist;
  }

  // Center + Y-bias
  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    fx[i] -= nd.x * SIM.centerPull * nd.mass;
    fz[i] -= nd.z * SIM.centerPull * nd.mass;
    const yTarget = SIM.yLevels[nd.type] ?? 0;
    fy[i] += (yTarget - nd.y) * SIM.yBias * nd.mass;
  }

  // Integrate
  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    nd.vx = (nd.vx + fx[i] / nd.mass) * SIM.damping;
    nd.vy = (nd.vy + fy[i] / nd.mass) * SIM.damping;
    nd.vz = (nd.vz + fz[i] / nd.mass) * SIM.damping;

    if (!isFinite(nd.vx) || !isFinite(nd.vy) || !isFinite(nd.vz)) {
      nd.vx = 0;
      nd.vy = 0;
      nd.vz = 0;
    }

    const speed = Math.sqrt(nd.vx * nd.vx + nd.vy * nd.vy + nd.vz * nd.vz);
    if (speed > SIM.maxSpeed) {
      const s = SIM.maxSpeed / speed;
      nd.vx *= s;
      nd.vy *= s;
      nd.vz *= s;
    }
    nd.x += nd.vx;
    nd.y += nd.vy;
    nd.z += nd.vz;

    if (!isFinite(nd.x)) nd.x = jitter(5);
    if (!isFinite(nd.y)) nd.y = SIM.yLevels[nd.type] ?? 0;
    if (!isFinite(nd.z)) nd.z = jitter(5);
  }
}

// ── Shared geometries ─────────────────────────────────────────────────

const SHARED_GEOM = {
  sub: new THREE.IcosahedronGeometry(0.9, 1),
  post: new THREE.OctahedronGeometry(0.55, 0),
  comment: new THREE.SphereGeometry(0.3, 12, 12),
};

// ── 3D Components ─────────────────────────────────────────────────────

function NodeVisual({
  color,
  emissiveColor,
  onClick,
  expanded,
  nodeType,
}: {
  color: string;
  emissiveColor: string;
  onClick: () => void;
  expanded: boolean;
  nodeType: "subreddit" | "post" | "comment";
}) {
  const ref = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const seed = useRef(Math.random() * 100);
  const _v3 = useRef(new THREE.Vector3());

  useFrame((state) => {
    try {
      if (!ref.current) return;
      ref.current.position.y =
        Math.sin(state.clock.elapsedTime * 0.6 + seed.current) * 0.08;
      ref.current.rotation.y += 0.003;
      const target = hovered ? 1.25 : expanded ? 1.15 : 1;
      ref.current.scale.lerp(_v3.current.set(target, target, target), 0.1);
    } catch {
      /* swallow */
    }
  });

  const geometry =
    nodeType === "subreddit"
      ? SHARED_GEOM.sub
      : nodeType === "post"
        ? SHARED_GEOM.post
        : SHARED_GEOM.comment;

  return (
    <>
      <mesh
        ref={ref}
        geometry={geometry}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "auto";
        }}
      >
        <meshStandardMaterial
          color={color}
          emissive={emissiveColor}
          emissiveIntensity={hovered ? 2.4 : expanded ? 1.8 : 1.6}
          roughness={0.2}
          metalness={0.4}
        />
      </mesh>
    </>
  );
}

function ForceEdges({
  simRef,
}: {
  simRef: MutableRefObject<SimState>;
}) {
  const ref = useRef<THREE.LineSegments>(null);
  const bufRef = useRef<Float32Array>(new Float32Array(6));
  const attrRef = useRef<THREE.BufferAttribute | null>(null);

  useFrame(() => {
    try {
      if (!ref.current) return;
      const { nodes, edges } = simRef.current;
      const needed = Math.max(edges.length * 6, 6);
      if (bufRef.current.length < needed) {
        bufRef.current = new Float32Array(needed);
        if (attrRef.current) attrRef.current.array = new Float32Array(0);
        attrRef.current = new THREE.BufferAttribute(bufRef.current, 3);
        attrRef.current.setUsage(THREE.DynamicDrawUsage);
        ref.current.geometry.setAttribute("position", attrRef.current);
      }
      const buf = bufRef.current;
      let k = 0;
      for (const e of edges) {
        const s = nodes.get(e.source);
        const t = nodes.get(e.target);
        if (s && t) {
          buf[k++] = s.x;
          buf[k++] = s.y;
          buf[k++] = s.z;
          buf[k++] = t.x;
          buf[k++] = t.y;
          buf[k++] = t.z;
        } else {
          k += 6;
        }
      }
      while (k < buf.length) buf[k++] = 0;
      if (attrRef.current) attrRef.current.needsUpdate = true;
      ref.current.geometry.setDrawRange(0, edges.length * 2);
    } catch {
      /* swallow */
    }
  });

  return (
    <lineSegments ref={ref}>
      <bufferGeometry />
      <lineBasicMaterial color={PAL.edge} transparent opacity={0.35} />
    </lineSegments>
  );
}

function PingRing({
  nodeId,
  birth,
  simRef,
}: {
  nodeId: string;
  birth: number;
  simRef: MutableRefObject<SimState>;
}) {
  const ref = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    try {
      if (!ref.current) return;
      const sn = simRef.current.nodes.get(nodeId);
      if (sn) ref.current.position.set(sn.x, sn.y, sn.z);
      const t = state.clock.elapsedTime - birth;
      const s = 1 + t * 2.5;
      ref.current.scale.set(s, s, s);
      (ref.current.material as THREE.MeshBasicMaterial).opacity = Math.max(
        0,
        0.7 - t * 0.25
      );
    } catch {
      /* swallow */
    }
  });

  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.6, 0.75, 32]} />
      <meshStandardMaterial
        color={PAL.pingNew}
        emissive={PAL.pingNew}
        emissiveIntensity={0.8}
        transparent
        opacity={0.7}
        side={THREE.DoubleSide}
        toneMapped={false}
        depthWrite={false}
      />
    </mesh>
  );
}

// ── ForceGraph ────────────────────────────────────────────────────────

function ForceGraph({
  graphNodes,
  pings,
  onNodeClick,
  expandedSubs,
  expandedPosts,
  simRef,
}: {
  graphNodes: GNodeData[];
  pings: Ping[];
  onNodeClick: (node: GNodeData) => void;
  expandedSubs: Set<string>;
  expandedPosts: Set<string>;
  simRef: MutableRefObject<SimState>;
}) {
  const groupRefs = useRef(new Map<string, THREE.Group>());
  const prevNodesRef = useRef<GNodeData[]>([]);

  useFrame(() => {
    try {
      if (prevNodesRef.current !== graphNodes) {
        syncSim(simRef.current, graphNodes);
        prevNodesRef.current = graphNodes;
      }
      stepSim(simRef.current);
      for (const [id, sn] of simRef.current.nodes) {
        const g = groupRefs.current.get(id);
        if (g) g.position.set(sn.x, sn.y, sn.z);
      }
    } catch {
      /* swallow */
    }
  });

  return (
    <>
      <ambientLight intensity={0.15} />
      <pointLight position={[20, 30, 10]} intensity={0.6} color="#c4b5fd" />
      <pointLight position={[-20, -10, 20]} intensity={0.3} color="#06b6d4" />
      <pointLight position={[0, -20, -20]} intensity={0.2} color="#f59e0b" />

      <Stars
        radius={100}
        depth={60}
        count={2500}
        factor={3}
        saturation={0.1}
        fade
        speed={0.5}
      />
      <fog attach="fog" args={[PAL.bg, 80, 400]} />

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={3}
        maxDistance={500}
        maxPolarAngle={Math.PI * 0.85}
      />

      <ForceEdges simRef={simRef} />

      {graphNodes.map((n) => {
        const isExpanded =
          n.type === "subreddit"
            ? expandedSubs.has(n.id.replace("sub-", ""))
            : n.type === "post"
              ? expandedPosts.has(n.id)
              : false;
        return (
          <group
            key={n.id}
            ref={(el) => {
              if (el) {
                groupRefs.current.set(n.id, el);
                const sn = simRef.current.nodes.get(n.id);
                if (sn) el.position.set(sn.x, sn.y, sn.z);
              } else {
                groupRefs.current.delete(n.id);
              }
            }}
          >
            <NodeVisual
              color={
                n.type === "subreddit"
                  ? PAL.sub
                  : n.type === "post"
                    ? PAL.post
                    : PAL.comment
              }
              emissiveColor={
                n.type === "subreddit"
                  ? PAL.subEmit
                  : n.type === "post"
                    ? PAL.postEmit
                    : PAL.commentEmit
              }
              onClick={() => onNodeClick(n)}
              expanded={isExpanded}
              nodeType={n.type}
            />
          </group>
        );
      })}

      {pings.map((p) => (
        <PingRing
          key={p.id}
          nodeId={p.nodeId}
          birth={p.birth}
          simRef={simRef}
        />
      ))}

      <EffectComposer multisampling={0} stencilBuffer={false}>
        <Bloom
          luminanceThreshold={0.1}
          luminanceSmoothing={0.95}
          intensity={0.8}
          mipmapBlur
        />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>
    </>
  );
}

// ── Clock sync ────────────────────────────────────────────────────────

const clockRef = { current: 0 };

function ClockSync() {
  useFrame((state) => {
    clockRef.current = state.clock.elapsedTime;
  });
  return null;
}

// ── Label Projector (runs inside Canvas, writes screen coords) ────────

interface LabelScreenPos {
  id: string;
  label: string;
  x: number;
  y: number;
  visible: boolean;
}

function LabelProjector({
  simRef,
  graphNodes,
  labelsRef,
}: {
  simRef: MutableRefObject<SimState>;
  graphNodes: GNodeData[];
  labelsRef: MutableRefObject<LabelScreenPos[]>;
}) {
  const { camera, size } = useThree();
  const _v3 = useRef(new THREE.Vector3());

  useFrame(() => {
    const result: LabelScreenPos[] = [];
    for (const n of graphNodes) {
      const sn = simRef.current.nodes.get(n.id);
      if (!sn) continue;
      const nodeSize = n.type === "subreddit" ? 0.9 : n.type === "post" ? 0.55 : 0.3;
      _v3.current.set(sn.x, sn.y + nodeSize + 0.5, sn.z);
      _v3.current.project(camera);
      const x = (_v3.current.x * 0.5 + 0.5) * size.width;
      const y = (-_v3.current.y * 0.5 + 0.5) * size.height;
      const visible = _v3.current.z < 1;
      result.push({ id: n.id, label: n.label, x, y, visible });
    }
    labelsRef.current = result;
  });

  return null;
}

function LabelsOverlay({
  labelsRef,
}: {
  labelsRef: MutableRefObject<LabelScreenPos[]>;
}) {
  const [positions, setPositions] = useState<LabelScreenPos[]>([]);

  useEffect(() => {
    const id = setInterval(() => {
      setPositions([...labelsRef.current]);
    }, 1000 / 30); // 30fps update for labels
    return () => clearInterval(id);
  }, [labelsRef]);

  return (
    <div className="graph-labels-overlay">
      {positions.map(
        (p) =>
          p.visible && (
            <div
              key={p.id}
              className="graph-node-label"
              style={{
                left: p.x,
                top: p.y,
              }}
            >
              {p.label}
            </div>
          )
      )}
    </div>
  );
}

// ── Post Preview Panel ────────────────────────────────────────────────

// ── Threaded Comment ──────────────────────────────────────────────────

interface ThreadedCommentItem {
  id: string;
  author: string;
  body: string;
  score: number;
  isTarget?: boolean;
  replies: ThreadedCommentItem[];
}

function ThreadedComment({
  comment,
  depth = 0,
  targetId,
}: {
  comment: ThreadedCommentItem;
  depth?: number;
  targetId?: string;
}) {
  const hasReplies = comment.replies.length > 0;
  const [collapsed, setCollapsed] = useState(false);
  const isTarget = comment.isTarget || comment.id === targetId;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isTarget && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [isTarget]);

  return (
    <div
      ref={ref}
      className={`graph-embed-comment ${isTarget ? "graph-embed-comment--target" : ""}`}
    >
      <div className="graph-embed-comment-head">
        {hasReplies && (
          <button
            className="graph-thread-toggle"
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? "▸" : "▾"}
          </button>
        )}
        u/{comment.author}
        <span className="graph-preview-comment-score">
          {comment.score} pts
        </span>
      </div>
      <div className="graph-embed-comment-body">{comment.body}</div>
      {hasReplies && !collapsed && (
        <div className="graph-thread-replies">
          {comment.replies.map((r) => (
            <ThreadedComment
              key={r.id}
              comment={r}
              depth={depth + 1}
              targetId={targetId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PostPreviewPanel({
  post,
  comments,
  onClose,
  onOpenReddit,
  isLoggedIn,
  onReply,
}: {
  post: GraphPost;
  comments: RedditComment[];
  onClose: () => void;
  onOpenReddit: () => void;
  isLoggedIn: boolean;
  onReply: (thingId: string, text: string) => void;
}) {
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  const handleSubmitReply = async () => {
    if (!replyText.trim() || !replyTo) return;
    setSending(true);
    try {
      onReply(replyTo, replyText);
      setReplyTo(null);
      setReplyText("");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={`graph-preview-panel ${collapsed ? "graph-preview-panel--collapsed" : ""}`}>
      <div className="graph-preview-header">
        <h4 className="graph-detail-title">{post.title}</h4>
        <div className="graph-preview-header-btns">
          <button
            className="graph-preview-collapse-btn"
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? "\u25B2" : "\u25BC"}
          </button>
          <button className="graph-detail-close" onClick={onClose}>
            &times;
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="graph-preview-content">
          <div className="graph-detail-meta">
            <span>u/{post.author}</span>
            <span>&middot;</span>
            <span>{post.score} pts</span>
            <span>&middot;</span>
            <span>{post.numComments} comments</span>
          </div>

          {post.videoUrl && (
            <video
              className="graph-embed-media"
              src={post.videoUrl}
              controls
              muted
              loop
              playsInline
            />
          )}
          {!post.videoUrl && post.imageUrl && (
            <img
              className="graph-embed-media"
              src={post.imageUrl}
              alt=""
              loading="lazy"
            />
          )}
          {!post.videoUrl && !post.imageUrl && post.galleryUrls.length > 0 && (
            <div className="graph-embed-gallery">
              {post.galleryUrls.map((url, i) => (
                <img key={i} className="graph-embed-media" src={url} alt="" loading="lazy" />
              ))}
            </div>
          )}
          {post.selftext && (
            <div className="graph-preview-body">{post.selftext}</div>
          )}
          {post.url && !post.isSelf && !post.imageUrl && !post.videoUrl && (
            <a
              className="graph-preview-link"
              href={post.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {post.url}
            </a>
          )}

          {comments.length > 0 && (
            <div className="graph-preview-comments">
              {comments.slice(0, 5).map((c) => (
                <ThreadedComment key={c.id} comment={c} />
              ))}
            </div>
          )}

          <div className="graph-preview-actions">
            <button className="graph-detail-reddit-btn" onClick={onOpenReddit}>
              Open on Reddit
            </button>
            {isLoggedIn && (
              <button
                className="graph-preview-reply-btn"
                onClick={() =>
                  setReplyTo(replyTo ? null : `t3_${post.redditId}`)
                }
              >
                {replyTo ? "Cancel" : "Reply"}
              </button>
            )}
          </div>

          {replyTo && (
            <div className="graph-preview-reply-form">
              <textarea
                className="graph-preview-reply-input"
                placeholder="Write a comment..."
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                rows={3}
              />
              <button
                className="graph-detail-reddit-btn"
                onClick={handleSubmitReply}
                disabled={sending || !replyText.trim()}
              >
                {sending ? "Sending..." : "Submit"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────

const MAX_POSTS = 15;
const MAX_COMMENTS = 12;

export function GraphPage() {
  // ── Data state ──
  const [subscribedSubs, setSubscribedSubs] = useState<string[]>(() =>
    getSavedSubreddits()
  );
  const [subSearch, setSubSearch] = useState("");
  const [searchResults, setSearchResults] = useState<
    { name: string; subscribers: number }[]
  >([]);
  const [searching, setSearching] = useState(false);
  const [expandedSubs, setExpandedSubs] = useState<Set<string>>(new Set());
  const [postsBySub, setPostsBySub] = useState<Record<string, GraphPost[]>>({});
  const [expandedPosts, setExpandedPosts] = useState<Set<string>>(new Set());
  const [commentsByPost, setCommentsByPost] = useState<
    Record<string, RedditComment[]>
  >({});
  const [pings, setPings] = useState<Ping[]>([]);
  const [selectedPost, setSelectedPost] = useState<GraphPost | null>(null);
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);
  const [embedCollapsed, setEmbedCollapsed] = useState(true);
  const [embedData, setEmbedData] = useState<{
    postTitle: string;
    postAuthor: string;
    postScore: number;
    postSelftext: string;
    postUrl: string;
    postIsSelf: boolean;
    subreddit: string;
    permalink: string;
    imageUrl: string | null;
    videoUrl: string | null;
    galleryUrls: string[];
    comments: ThreadedCommentItem[];
  } | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [loggedIn, setLoggedIn] = useState(() => auth.isLoggedIn());
  const [redditUser, setRedditUser] = useState<RedditUser | null>(null);

  // Handle OAuth callback on mount
  useEffect(() => {
    if (window.location.search.includes("code=")) {
      auth.handleCallback().then((ok) => {
        if (ok) {
          setLoggedIn(true);
          auth.getUser().then(setRedditUser).catch(() => {});
        }
      });
    } else if (loggedIn) {
      auth.getUser().then(setRedditUser).catch(() => {});
    }
  }, []);

  // Simulation state
  const simRef = useRef<SimState>({ nodes: new Map(), edges: [] });
  const labelsRef = useRef<LabelScreenPos[]>([]);

  // Persist subscriptions
  useEffect(() => {
    saveSubreddits(subscribedSubs);
  }, [subscribedSubs]);

  // All subs currently "enabled" for display (opt-in model)
  const enabledSubs = useMemo(() => new Set(subscribedSubs), [subscribedSubs]);

  // ── Subreddit search ──
  useEffect(() => {
    const q = subSearch.trim();
    if (q.length < 2) {
      setSearchResults([]);
      return;
    }
    const timeout = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await reddit.searchSubreddits(q, 10);
        setSearchResults(
          results.map((r) => ({
            name: r.display_name || r.name,
            subscribers: r.subscribers,
          }))
        );
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [subSearch]);

  // ── Subscribe / unsubscribe ──
  const subscribe = useCallback((name: string) => {
    setSubscribedSubs((prev) => {
      if (prev.includes(name)) return prev;
      return [...prev, name].sort();
    });
    setSubSearch("");
    setSearchResults([]);
  }, []);

  const unsubscribe = useCallback((name: string) => {
    setSubscribedSubs((prev) => prev.filter((s) => s !== name));
    setExpandedSubs((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  }, []);

  // ── Fetch posts for sub ──
  const fetchPostsForSub = useCallback(async (name: string) => {
    try {
      const posts = await reddit.getHot(name, MAX_POSTS);
      const gp: GraphPost[] = posts.map((p) => {
        let imageUrl: string | null = null;
        let videoUrl: string | null = null;
        const galleryUrls: string[] = [];
        const url = p.url ?? "";
        if (/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url)) imageUrl = url;
        if (!imageUrl && p.preview?.images?.[0]?.source?.url) imageUrl = p.preview.images[0].source.url;
        if (p.media?.reddit_video?.fallback_url) videoUrl = p.media.reddit_video.fallback_url;
        if (!videoUrl && p.is_video && url.includes("v.redd.it")) videoUrl = `${url}/DASH_720.mp4`;
        if (p.media_metadata) {
          for (const item of Object.values(p.media_metadata)) {
            if (item.status === "valid" && item.s?.u) galleryUrls.push(item.s.u);
          }
        }
        return {
          key: `${name}-${p.id}`,
          redditId: p.id,
          title: p.title,
          subreddit: name,
          author: p.author,
          score: p.score,
          numComments: p.num_comments,
          permalink: p.permalink,
          selftext: p.selftext,
          url: p.url,
          isSelf: p.is_self,
          imageUrl,
          videoUrl,
          galleryUrls,
        };
      });
      setPostsBySub((prev) => ({ ...prev, [name]: gp }));

      // Add pings for new posts
      setPings((prev) => [
        ...prev,
        ...gp.slice(0, 3).map((p) => ({
          id: `ping-${p.key}-${Date.now()}`,
          nodeId: `sub-${name}`,
          birth: clockRef.current,
        })),
      ]);
    } catch {
      setPostsBySub((prev) => ({ ...prev, [name]: [] }));
    }
  }, []);

  // ── Refresh polling (every 60s for live updates) ──
  useEffect(() => {
    const interval = setInterval(() => {
      for (const sub of expandedSubs) {
        fetchPostsForSub(sub);
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [expandedSubs, fetchPostsForSub]);

  // ── Expire pings ──
  useEffect(() => {
    const id = setInterval(() => {
      setPings((prev) =>
        prev.filter((p) => clockRef.current - p.birth < 3.5)
      );
    }, 2000);
    return () => clearInterval(id);
  }, []);

  // ── Expand/collapse handlers ──
  const toggleSub = useCallback(
    (name: string) => {
      setExpandedSubs((prev) => {
        const next = new Set(prev);
        if (next.has(name)) {
          next.delete(name);
          setExpandedPosts((ep) => {
            const np = new Set(ep);
            (postsBySub[name] ?? []).forEach((p) => np.delete(p.key));
            return np;
          });
        } else {
          next.add(name);
          if (!postsBySub[name]) {
            fetchPostsForSub(name);
          }
        }
        return next;
      });
    },
    [postsBySub, fetchPostsForSub]
  );

  const togglePost = useCallback(
    (postKey: string, subreddit: string, redditId: string) => {
      setExpandedPosts((prev) => {
        const next = new Set(prev);
        if (next.has(postKey)) {
          next.delete(postKey);
        } else {
          next.add(postKey);
          if (!commentsByPost[postKey]) {
            reddit
              .getComments(subreddit, redditId, MAX_COMMENTS)
              .then((comments) => {
                setCommentsByPost((prev2) => ({
                  ...prev2,
                  [postKey]: comments.slice(0, MAX_COMMENTS),
                }));
                // Ping for comments loading
                setPings((p) => [
                  ...p,
                  ...comments.slice(0, 2).map((c, i) => ({
                    id: `ping-comment-${c.id}-${i}-${Date.now()}`,
                    nodeId: `post-${postKey}`,
                    birth: clockRef.current,
                  })),
                ]);
              })
              .catch(() => {
                setCommentsByPost((prev2) => ({ ...prev2, [postKey]: [] }));
              });
          }
        }
        return next;
      });
    },
    [commentsByPost]
  );

  const handleNodeClick = useCallback(
    (node: GNodeData) => {
      if (node.type === "subreddit") {
        toggleSub(node.id.replace("sub-", ""));
      } else if (node.type === "post") {
        const postKey = node.id.replace("post-", "");
        const allPosts = Object.values(postsBySub).flat();
        const gp = allPosts.find((p) => p.key === postKey);
        if (gp) {
          togglePost(postKey, gp.subreddit, gp.redditId);
          setSelectedPost(gp);
        }
      } else if (node.type === "comment" && node.permalink) {
        setEmbedUrl(node.permalink);
        setEmbedData(null);
        setSelectedPost(null);
        // Fetch full thread context
        const cleanPath = node.permalink.replace(/\/+$/, "");
        const commentId = node.id.replace("comment-", "");
        // Go up to the post level to get full context
        const postPath = cleanPath.split("/").slice(0, 6).join("/");
        fetch(`https://www.reddit.com${postPath}.json?raw_json=1&limit=50`, {
          headers: { Accept: "application/json" },
        })
          .then((r) => {
            if (!r.ok) throw new Error(`${r.status}`);
            return r.json();
          })
          .then((data) => {
            const postData = data[0]?.data?.children?.[0]?.data;
            const rawComments = data[1]?.data?.children ?? [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            function mapComments(children: any[]): ThreadedCommentItem[] {
              return children
                .filter((c: { kind: string }) => c.kind === "t1")
                .map((c: { data: any }) => ({
                  id: c.data.id ?? "",
                  author: c.data.author ?? "",
                  body: c.data.body ?? "",
                  score: c.data.score ?? 0,
                  isTarget: c.data.id === commentId,
                  replies:
                    c.data.replies?.data?.children
                      ? mapComments(c.data.replies.data.children)
                      : [],
                }));
            }
            const comments = mapComments(rawComments);

            // Extract media
            let imageUrl: string | null = null;
            let videoUrl: string | null = null;
            const galleryUrls: string[] = [];

            if (postData) {
              const url = postData.url ?? "";
              // Direct image link
              if (/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url)) {
                imageUrl = url;
              }
              // Reddit preview image
              if (!imageUrl && postData.preview?.images?.[0]?.source?.url) {
                imageUrl = postData.preview.images[0].source.url;
              }
              // Reddit hosted video
              if (postData.media?.reddit_video?.fallback_url) {
                videoUrl = postData.media.reddit_video.fallback_url;
              }
              // v.redd.it URL
              if (!videoUrl && postData.is_video && url.includes("v.redd.it")) {
                videoUrl = `${url}/DASH_720.mp4`;
              }
              // Gallery
              if (postData.media_metadata) {
                for (const item of Object.values(postData.media_metadata) as { s?: { u?: string }; status?: string }[]) {
                  if (item.status === "valid" && item.s?.u) {
                    galleryUrls.push(item.s.u);
                  }
                }
              }
            }

            setEmbedData({
              postTitle: postData?.title ?? "",
              postAuthor: postData?.author ?? "",
              postScore: postData?.score ?? 0,
              postSelftext: postData?.selftext ?? "",
              postUrl: postData?.url ?? "",
              postIsSelf: postData?.is_self ?? true,
              subreddit: postData?.subreddit ?? "",
              permalink: node.permalink!,
              imageUrl,
              videoUrl,
              galleryUrls,
              comments,
            });
          })
          .catch(() => {
            setEmbedData({
              postTitle: "",
              postAuthor: "",
              postScore: 0,
              postSelftext: "",
              postUrl: "",
              postIsSelf: true,
              subreddit: node.subName ?? "",
              permalink: node.permalink!,
              imageUrl: null,
              videoUrl: null,
              galleryUrls: [],
              comments: [{ id: "error", author: node.label, body: "(Could not load)", score: node.score ?? 0, isTarget: true, replies: [] }],
            });
          });
      }
    },
    [toggleSub, togglePost, postsBySub]
  );

  // ── Build graph nodes ──
  const graphNodes: GNodeData[] = useMemo(() => {
    const result: GNodeData[] = [];

    for (const name of enabledSubs) {
      result.push({
        id: `sub-${name}`,
        type: "subreddit",
        label: `r/${name}`,
        parentId: null,
        subName: name,
        postId: null,
        permalink: null,
        score: null,
      });
    }

    for (const subName of expandedSubs) {
      if (!enabledSubs.has(subName)) continue;
      const posts = postsBySub[subName] ?? [];
      for (const p of posts) {
        result.push({
          id: `post-${p.key}`,
          type: "post",
          label: truncate(p.title, 24),
          parentId: `sub-${subName}`,
          subName: subName,
          postId: p.redditId,
          permalink: p.permalink,
          score: p.score,
        });
      }
    }

    for (const postKey of expandedPosts) {
      const comments = commentsByPost[postKey] ?? [];
      const postNode = result.find(
        (n) => n.type === "post" && n.id === `post-${postKey}`
      );
      if (!postNode) continue;
      for (const c of comments) {
        result.push({
          id: `comment-${c.id}`,
          type: "comment",
          label: truncate(c.author, 16),
          parentId: postNode.id,
          subName: postNode.subName,
          postId: null,
          permalink: c.permalink,
          score: c.score,
        });
      }
    }

    return result;
  }, [enabledSubs, expandedSubs, postsBySub, expandedPosts, commentsByPost]);

  // ── Stats ──
  const stats = useMemo(() => {
    const s = graphNodes.filter((n) => n.type === "subreddit").length;
    const p = graphNodes.filter((n) => n.type === "post").length;
    const c = graphNodes.filter((n) => n.type === "comment").length;
    return { subreddits: s, posts: p, comments: c };
  }, [graphNodes]);

  // ── Format subscriber count ──
  const formatSubs = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
  };

  const handleReply = useCallback(
    async (thingId: string, text: string) => {
      try {
        await postApi.comment(thingId, text);
      } catch (err) {
        console.error("Failed to post comment:", err);
      }
    },
    []
  );

  // Comments for selected post
  const selectedPostComments = selectedPost
    ? commentsByPost[selectedPost.key] ?? []
    : [];

  return (
    <div className="graph-page">
      <GraphErrorBoundary>
        <Canvas
          camera={{ position: [0, 12, 35], fov: 55 }}
          dpr={[1, 1.5]}
          gl={{
            antialias: true,
            alpha: false,
            powerPreference: "high-performance",
          }}
          onCreated={({ gl }) => {
            gl.setClearColor(PAL.bg);
            gl.toneMapping = THREE.NoToneMapping;
            const canvas = gl.domElement;
            canvas.addEventListener("webglcontextlost", (e) => {
              e.preventDefault();
            });
            canvas.addEventListener("webglcontextrestored", () => {
              gl.setClearColor(PAL.bg);
            });
          }}
        >
          <ClockSync />
          <LabelProjector simRef={simRef} graphNodes={graphNodes} labelsRef={labelsRef} />
          <ForceGraph
            graphNodes={graphNodes}
            pings={pings}
            onNodeClick={handleNodeClick}
            expandedSubs={expandedSubs}
            expandedPosts={expandedPosts}
            simRef={simRef}
          />
        </Canvas>
      </GraphErrorBoundary>

      {/* Projected labels (pure DOM, no WebGL interaction) */}
      <LabelsOverlay labelsRef={labelsRef} />

      {/* Collapsible overlay UI */}
      <div
        className={`graph-overlay ${panelCollapsed ? "graph-overlay--collapsed" : ""}`}
      >
        <button
          className="graph-collapse-btn"
          onClick={() => setPanelCollapsed((p) => !p)}
        >
          {panelCollapsed ? "\u00BB" : "\u00AB"}
        </button>

        <div className="graph-overlay-content">
          <div className="graph-panel">
            <h3 className="graph-panel-title">Gravitas</h3>
            <p className="graph-panel-hint">
              Subscribe to subreddits to watch them live. Click nodes to expand.
            </p>
            <div className="graph-stats">
              <span className="graph-stat">
                <span
                  className="graph-stat-dot"
                  style={{ background: PAL.sub }}
                />
                {stats.subreddits} subreddits
              </span>
              <span className="graph-stat">
                <span
                  className="graph-stat-dot"
                  style={{ background: PAL.post }}
                />
                {stats.posts} posts
              </span>
              <span className="graph-stat">
                <span
                  className="graph-stat-dot"
                  style={{ background: PAL.comment }}
                />
                {stats.comments} comments
              </span>
            </div>

            {/* Auth button */}
            <div className="graph-auth">
              {loggedIn ? (
                <div className="graph-auth-user">
                  <span className="graph-auth-name">
                    u/{redditUser?.name ?? "..."}
                  </span>
                  <button
                    className="graph-auth-btn graph-auth-btn--logout"
                    onClick={() => {
                      auth.logout();
                      setLoggedIn(false);
                      setRedditUser(null);
                    }}
                  >
                    Logout
                  </button>
                </div>
              ) : (
                <button
                  className="graph-auth-btn"
                  onClick={() => auth.login()}
                >
                  Login with Reddit
                </button>
              )}
            </div>
          </div>

          {/* Subreddit search + subscribe */}
          <div className="graph-picker">
            <div className="graph-picker-header">
              <input
                className="graph-picker-search"
                type="text"
                placeholder="Search subreddits to subscribe..."
                value={subSearch}
                onChange={(e) => setSubSearch(e.target.value)}
              />
            </div>

            {/* Search results */}
            {(searchResults.length > 0 || searching) && (
              <div className="graph-picker-list graph-search-results">
                {searching && (
                  <div className="graph-picker-empty">Searching...</div>
                )}
                {searchResults.map((r) => {
                  const alreadySubbed = subscribedSubs.includes(r.name);
                  return (
                    <button
                      key={r.name}
                      className={`graph-picker-item ${alreadySubbed ? "active" : ""}`}
                      onClick={() => !alreadySubbed && subscribe(r.name)}
                      disabled={alreadySubbed}
                    >
                      <span
                        className="graph-picker-dot"
                        style={{
                          background: alreadySubbed ? PAL.sub : "transparent",
                        }}
                      />
                      <span style={{ flex: 1 }}>r/{r.name}</span>
                      <span
                        style={{
                          fontSize: "0.7rem",
                          color: "var(--color-text-muted)",
                        }}
                      >
                        {formatSubs(r.subscribers)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Subscribed list */}
            {subscribedSubs.length > 0 && searchResults.length === 0 && (
              <div className="graph-picker-list">
                {subscribedSubs.map((name) => (
                  <div key={name} className="graph-picker-item active">
                    <span
                      className="graph-picker-dot"
                      style={{ background: PAL.sub }}
                    />
                    <span
                      style={{ flex: 1, cursor: "pointer" }}
                      onClick={() => toggleSub(name)}
                    >
                      r/{name}
                      {expandedSubs.has(name) && (
                        <span
                          style={{
                            marginLeft: "0.3rem",
                            fontSize: "0.65rem",
                            color: PAL.post,
                          }}
                        >
                          expanded
                        </span>
                      )}
                    </span>
                    <button
                      className="graph-unsub-btn"
                      onClick={() => unsubscribe(name)}
                      title="Unsubscribe"
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            )}

            {subscribedSubs.length === 0 && searchResults.length === 0 && (
              <div className="graph-picker-empty">
                Search and subscribe to subreddits to get started
              </div>
            )}
          </div>

          <div className="graph-legend">
            <div className="graph-legend-row">
              <span
                className="graph-legend-swatch"
                style={{ background: PAL.sub }}
              />
              Subreddit
            </div>
            <div className="graph-legend-row">
              <span
                className="graph-legend-swatch"
                style={{ background: PAL.post }}
              />
              Post
            </div>
            <div className="graph-legend-row">
              <span
                className="graph-legend-swatch"
                style={{ background: PAL.comment }}
              />
              Comment
            </div>
          </div>

        </div>
      </div>

      {/* Controls help */}
      <div className="graph-controls-help">
        <div className="graph-controls-row">
          <kbd>Scroll</kbd> <span>Zoom</span>
        </div>
        <div className="graph-controls-row">
          <kbd>Click + Drag</kbd> <span>Orbit</span>
        </div>
        <div className="graph-controls-row">
          <kbd>Right-click + Drag</kbd> <span>Pan</span>
        </div>
      </div>

      {/* Post preview panel */}
      {selectedPost && !embedUrl && (
        <PostPreviewPanel
          post={selectedPost}
          comments={selectedPostComments}
          onClose={() => setSelectedPost(null)}
          onOpenReddit={() =>
            window.open(
              `https://reddit.com${selectedPost.permalink}`,
              "_blank"
            )
          }
          isLoggedIn={loggedIn}
          onReply={handleReply}
        />
      )}

      {/* Comment detail panel */}
      {embedUrl && (
        <div className={`graph-embed-panel ${embedCollapsed ? "graph-embed-panel--collapsed" : ""}`}>
          <div className="graph-embed-header">
            <div className="graph-preview-header-btns">
              <button
                className="graph-preview-collapse-btn"
                onClick={() => setEmbedCollapsed((c) => !c)}
              >
                {embedCollapsed ? "\u25B2" : "\u25BC"}
              </button>
              <button
                className="graph-detail-close"
                onClick={() => {
                  setEmbedUrl(null);
                  setEmbedData(null);
                }}
              >
                &times;
              </button>
            </div>
            <a
              className="graph-embed-open"
              href={`https://reddit.com${embedUrl}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open on Reddit
            </a>
          </div>
          {embedData ? (
            <div className="graph-embed-content">
              <div className="graph-embed-post-title">
                {embedData.postTitle}
              </div>
              <div className="graph-embed-post-meta">
                r/{embedData.subreddit} &middot; u/{embedData.postAuthor} &middot; {embedData.postScore} pts
              </div>
              {embedData.videoUrl && (
                <video
                  className="graph-embed-media"
                  src={embedData.videoUrl}
                  controls
                  muted
                  loop
                  playsInline
                />
              )}
              {!embedData.videoUrl && embedData.imageUrl && (
                <img
                  className="graph-embed-media"
                  src={embedData.imageUrl}
                  alt=""
                  loading="lazy"
                />
              )}
              {!embedData.videoUrl && !embedData.imageUrl && embedData.galleryUrls.length > 0 && (
                <div className="graph-embed-gallery">
                  {embedData.galleryUrls.map((url, i) => (
                    <img
                      key={i}
                      className="graph-embed-media"
                      src={url}
                      alt=""
                      loading="lazy"
                    />
                  ))}
                </div>
              )}
              {embedData.postSelftext && (
                <div className="graph-embed-selftext">{embedData.postSelftext}</div>
              )}
              {embedData.postUrl && !embedData.postIsSelf && !embedData.imageUrl && !embedData.videoUrl && (
                <a
                  className="graph-preview-link"
                  href={embedData.postUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {embedData.postUrl}
                </a>
              )}
              <div className="graph-embed-comments-list">
                {embedData.comments.map((c) => (
                  <ThreadedComment key={c.id} comment={c} />
                ))}
              </div>
            </div>
          ) : (
            <div className="graph-picker-empty">Loading...</div>
          )}
        </div>
      )}
    </div>
  );
}
