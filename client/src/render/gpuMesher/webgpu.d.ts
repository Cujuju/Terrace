// WebGPU surface the GPU mesher uses; TS 7.0's lib has none and @webgpu/types is not a
// dependency. Replace with that package once approved.

type GPUFlagsConstant = number;

declare const GPUBufferUsage: {
  readonly MAP_READ: GPUFlagsConstant;
  readonly MAP_WRITE: GPUFlagsConstant;
  readonly COPY_SRC: GPUFlagsConstant;
  readonly COPY_DST: GPUFlagsConstant;
  readonly INDEX: GPUFlagsConstant;
  readonly VERTEX: GPUFlagsConstant;
  readonly UNIFORM: GPUFlagsConstant;
  readonly STORAGE: GPUFlagsConstant;
  readonly INDIRECT: GPUFlagsConstant;
  readonly QUERY_RESOLVE: GPUFlagsConstant;
};

declare const GPUShaderStage: {
  readonly VERTEX: GPUFlagsConstant;
  readonly FRAGMENT: GPUFlagsConstant;
  readonly COMPUTE: GPUFlagsConstant;
};

declare const GPUMapMode: {
  readonly READ: GPUFlagsConstant;
  readonly WRITE: GPUFlagsConstant;
};

interface GPUObjectBase {
  label: string;
}

interface GPUBufferDescriptor {
  label?: string;
  size: number;
  usage: GPUFlagsConstant;
  mappedAtCreation?: boolean;
}

interface GPUBuffer extends GPUObjectBase {
  readonly size: number;
  readonly usage: GPUFlagsConstant;
  readonly mapState: 'unmapped' | 'pending' | 'mapped';
  mapAsync(mode: GPUFlagsConstant, offset?: number, size?: number): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

interface GPUQueue extends GPUObjectBase {
  submit(commandBuffers: readonly GPUCommandBuffer[]): void;
  onSubmittedWorkDone(): Promise<void>;
  writeBuffer(
    buffer: GPUBuffer,
    bufferOffset: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOffset?: number,
    size?: number,
  ): void;
}

interface GPUCommandBuffer extends GPUObjectBase {}

interface GPUComputePassTimestampWrites {
  querySet: GPUQuerySet;
  beginningOfPassWriteIndex?: number;
  endOfPassWriteIndex?: number;
}

interface GPUComputePassDescriptor {
  label?: string;
  timestampWrites?: GPUComputePassTimestampWrites;
}

interface GPUComputePassEncoder extends GPUObjectBase {
  setPipeline(pipeline: GPUComputePipeline): void;
  setBindGroup(index: number, bindGroup: GPUBindGroup, dynamicOffsets?: readonly number[]): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  end(): void;
}

interface GPUCommandEncoderDescriptor {
  label?: string;
}

interface GPUCommandEncoder extends GPUObjectBase {
  beginComputePass(descriptor?: GPUComputePassDescriptor): GPUComputePassEncoder;
  copyBufferToBuffer(
    source: GPUBuffer,
    sourceOffset: number,
    destination: GPUBuffer,
    destinationOffset: number,
    size: number,
  ): void;
  clearBuffer(buffer: GPUBuffer, offset?: number, size?: number): void;
  resolveQuerySet(
    querySet: GPUQuerySet,
    firstQuery: number,
    queryCount: number,
    destination: GPUBuffer,
    destinationOffset: number,
  ): void;
  finish(descriptor?: { label?: string }): GPUCommandBuffer;
}

interface GPUShaderModuleDescriptor {
  label?: string;
  code: string;
}

interface GPUCompilationMessage {
  readonly message: string;
  readonly type: 'error' | 'warning' | 'info';
  readonly lineNum: number;
  readonly linePos: number;
}

interface GPUCompilationInfo {
  readonly messages: readonly GPUCompilationMessage[];
}

interface GPUShaderModule extends GPUObjectBase {
  getCompilationInfo(): Promise<GPUCompilationInfo>;
}

interface GPUBufferBindingLayout {
  type?: 'uniform' | 'storage' | 'read-only-storage';
  hasDynamicOffset?: boolean;
  minBindingSize?: number;
}

interface GPUBindGroupLayoutEntry {
  binding: number;
  visibility: GPUFlagsConstant;
  buffer?: GPUBufferBindingLayout;
}

interface GPUBindGroupLayoutDescriptor {
  label?: string;
  entries: readonly GPUBindGroupLayoutEntry[];
}

interface GPUBindGroupLayout extends GPUObjectBase {}

interface GPUBufferBinding {
  buffer: GPUBuffer;
  offset?: number;
  size?: number;
}

interface GPUBindGroupEntry {
  binding: number;
  resource: GPUBufferBinding;
}

interface GPUBindGroupDescriptor {
  label?: string;
  layout: GPUBindGroupLayout;
  entries: readonly GPUBindGroupEntry[];
}

interface GPUBindGroup extends GPUObjectBase {}

interface GPUPipelineLayoutDescriptor {
  label?: string;
  bindGroupLayouts: readonly GPUBindGroupLayout[];
}

interface GPUPipelineLayout extends GPUObjectBase {}

interface GPUProgrammableStage {
  module: GPUShaderModule;
  entryPoint?: string;
  constants?: Record<string, number>;
}

interface GPUComputePipelineDescriptor {
  label?: string;
  layout: GPUPipelineLayout | 'auto';
  compute: GPUProgrammableStage;
}

interface GPUComputePipeline extends GPUObjectBase {
  getBindGroupLayout(index: number): GPUBindGroupLayout;
}

interface GPUQuerySetDescriptor {
  label?: string;
  type: 'occlusion' | 'timestamp';
  count: number;
}

interface GPUQuerySet extends GPUObjectBase {
  readonly type: 'occlusion' | 'timestamp';
  readonly count: number;
  destroy(): void;
}

interface GPUSupportedLimits {
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxComputeWorkgroupsPerDimension: number;
  readonly maxComputeInvocationsPerWorkgroup: number;
  readonly maxComputeWorkgroupSizeX: number;
  readonly minUniformBufferOffsetAlignment: number;
  readonly minStorageBufferOffsetAlignment: number;
  readonly maxBindGroups: number;
  readonly maxStorageBuffersPerShaderStage: number;
}

interface GPUSupportedFeatures {
  has(feature: string): boolean;
}

interface GPUDeviceLostInfo {
  readonly reason: 'unknown' | 'destroyed';
  readonly message: string;
}

interface GPUError {
  readonly message: string;
}

interface GPUUncapturedErrorEvent extends Event {
  readonly error: GPUError;
}

interface GPUDevice extends GPUObjectBase, EventTarget {
  readonly features: GPUSupportedFeatures;
  readonly limits: GPUSupportedLimits;
  readonly queue: GPUQueue;
  readonly lost: Promise<GPUDeviceLostInfo>;
  createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
  createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule;
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout;
  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayout;
  createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup;
  createComputePipeline(descriptor: GPUComputePipelineDescriptor): GPUComputePipeline;
  createComputePipelineAsync(descriptor: GPUComputePipelineDescriptor): Promise<GPUComputePipeline>;
  createCommandEncoder(descriptor?: GPUCommandEncoderDescriptor): GPUCommandEncoder;
  createQuerySet(descriptor: GPUQuerySetDescriptor): GPUQuerySet;
  pushErrorScope(filter: 'validation' | 'out-of-memory' | 'internal'): void;
  popErrorScope(): Promise<GPUError | null>;
  destroy(): void;
}
