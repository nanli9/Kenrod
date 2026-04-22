'use client';

import { Suspense, useState, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment, Center } from '@react-three/drei';

function PlaceholderBox() {
  return (
    <Center>
      <mesh>
        <boxGeometry args={[2, 2, 2]} />
        <meshStandardMaterial color="#e94560" wireframe />
      </mesh>
    </Center>
  );
}

export default function ProductViewer3D({
  modelPath,
}: {
  modelPath?: string;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div className="w-full h-[400px] bg-gray-900 rounded-lg animate-pulse" />
    );
  }

  return (
    <div className="w-full h-[400px] bg-gray-900 rounded-lg overflow-hidden">
      <Canvas camera={{ position: [4, 3, 4], fov: 50 }}>
        <ambientLight intensity={0.5} />
        <directionalLight position={[5, 5, 5]} intensity={1} />
        <Suspense fallback={null}>
          {/* When modelPath is provided and a real .glb is loaded, replace PlaceholderBox with:
              import { useGLTF } from '@react-three/drei';
              const { scene } = useGLTF(modelPath);
              <primitive object={scene} />
          */}
          <PlaceholderBox />
          <Environment preset="studio" />
        </Suspense>
        <OrbitControls enablePan={false} />
      </Canvas>
    </div>
  );
}
