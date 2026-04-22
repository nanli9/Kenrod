'use client';

import { useRef, useState, useEffect, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function ProductModel({ progress }: { progress: number }) {
  const groupRef = useRef<THREE.Group>(null);
  const wireframeRef = useRef<THREE.Mesh>(null);
  const solidRef = useRef<THREE.Mesh>(null);
  const innerRef = useRef<THREE.Mesh>(null);

  // Smooth the progress value
  const smoothProgress = useRef(0);

  useFrame(() => {
    smoothProgress.current = lerp(smoothProgress.current, progress, 0.05);
    const p = smoothProgress.current;

    if (groupRef.current) {
      // Continuous slow rotation + scroll-driven rotation
      groupRef.current.rotation.y += 0.003;
      groupRef.current.rotation.x = lerp(0, Math.PI * 0.25, p);

      // Scale pulse at midpoint
      const scalePulse = 1 + Math.sin(p * Math.PI) * 0.15;
      groupRef.current.scale.setScalar(scalePulse);
    }

    // Wireframe: visible at start, fades as we progress
    if (wireframeRef.current) {
      const mat = wireframeRef.current.material as THREE.MeshStandardMaterial;
      mat.opacity = lerp(1, 0, Math.min(p * 2, 1));
    }

    // Solid: fades in during middle section
    if (solidRef.current) {
      const mat = solidRef.current.material as THREE.MeshStandardMaterial;
      mat.opacity = lerp(0, 0.85, Math.min(Math.max((p - 0.2) * 2.5, 0), 1));
    }

    // Inner mechanism: appears in later section
    if (innerRef.current) {
      innerRef.current.rotation.z += 0.01;
      innerRef.current.rotation.x += 0.005;
      const scale = lerp(0, 1, Math.min(Math.max((p - 0.3) * 3, 0), 1));
      innerRef.current.scale.setScalar(scale);
    }
  });

  return (
    <group ref={groupRef}>
      {/* Wireframe outer shell */}
      <mesh ref={wireframeRef}>
        <torusKnotGeometry args={[1, 0.35, 128, 32]} />
        <meshStandardMaterial
          color="#e94560"
          wireframe
          transparent
          opacity={1}
        />
      </mesh>

      {/* Solid outer shell */}
      <mesh ref={solidRef}>
        <torusKnotGeometry args={[1, 0.35, 128, 32]} />
        <meshStandardMaterial
          color="#e94560"
          transparent
          opacity={0}
          metalness={0.8}
          roughness={0.2}
        />
      </mesh>

      {/* Inner mechanism */}
      <mesh ref={innerRef} scale={0}>
        <icosahedronGeometry args={[0.5, 1]} />
        <meshStandardMaterial
          color="#4ecdc4"
          wireframe
          emissive="#4ecdc4"
          emissiveIntensity={0.3}
        />
      </mesh>
    </group>
  );
}

function CameraController({ progress }: { progress: number }) {
  const { camera } = useThree();
  const smoothProgress = useRef(0);

  useFrame(() => {
    smoothProgress.current = lerp(smoothProgress.current, progress, 0.05);
    const p = smoothProgress.current;

    // Camera moves closer during middle, pulls back at end
    const dist = p < 0.5
      ? lerp(5, 3, p * 2)
      : lerp(3, 6, (p - 0.5) * 2);

    const angle = lerp(0, Math.PI * 0.5, p);
    camera.position.x = Math.cos(angle) * dist;
    camera.position.z = Math.sin(angle) * dist + 3;
    camera.position.y = lerp(2, 1, p);
    camera.lookAt(0, 0, 0);
  });

  return null;
}

function Particles({ progress }: { progress: number }) {
  const pointsRef = useRef<THREE.Points>(null);

  const positions = useMemo(() => {
    const arr = new Float32Array(200 * 3);
    for (let i = 0; i < 200; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 10;
      arr[i * 3 + 1] = (Math.random() - 0.5) * 10;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 10;
    }
    return arr;
  }, []);

  useFrame(() => {
    if (pointsRef.current) {
      pointsRef.current.rotation.y += 0.0005;
      const mat = pointsRef.current.material as THREE.PointsMaterial;
      mat.opacity = lerp(0.2, 0.6, progress);
    }
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.03}
        color="#e94560"
        transparent
        opacity={0.2}
        sizeAttenuation
      />
    </points>
  );
}

function Scene({ progress }: { progress: number }) {
  return (
    <>
      <ambientLight intensity={0.3} />
      <directionalLight position={[5, 5, 5]} intensity={1} color="#ffffff" />
      <directionalLight position={[-3, 2, -5]} intensity={0.5} color="#4ecdc4" />
      <ProductModel progress={progress} />
      <Particles progress={progress} />
      <CameraController progress={progress} />
    </>
  );
}

export default function ScrollScene({
  stages,
}: {
  stages: { title: string; text: string }[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [activeStage, setActiveStage] = useState(0);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const scrollHeight = containerRef.current.offsetHeight - window.innerHeight;
      const scrolled = -rect.top;
      const p = Math.max(0, Math.min(1, scrolled / scrollHeight));
      setProgress(p);
      setActiveStage(Math.min(Math.floor(p * stages.length), stages.length - 1));
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [stages.length]);

  if (!mounted) {
    return <div className="h-[300vh] bg-gray-950" />;
  }

  return (
    <div ref={containerRef} className="relative h-[300vh] bg-gray-950">
      {/* Sticky canvas */}
      <div className="sticky top-0 h-screen w-full overflow-hidden">
        <Canvas>
          <Scene progress={progress} />
        </Canvas>

        {/* Text overlay */}
        <div className="absolute inset-0 flex items-center pointer-events-none">
          <div className="max-w-7xl mx-auto px-4 w-full">
            <div className="max-w-md">
              {stages.map((stage, i) => (
                <div
                  key={i}
                  className={`absolute transition-all duration-700 ${
                    activeStage === i
                      ? 'opacity-100 translate-y-0'
                      : activeStage > i
                        ? 'opacity-0 -translate-y-8'
                        : 'opacity-0 translate-y-8'
                  }`}
                >
                  <h3 className="text-3xl md:text-4xl font-bold text-white mb-4">
                    {stage.title}
                  </h3>
                  <p className="text-gray-400 text-lg">
                    {stage.text}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 w-32 h-1 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-100"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
