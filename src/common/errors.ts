/** 领域错误码：所有可预期的参数/历程/作业校验失败都用它，便于控制器映射 HTTP 状态。 */
export type ViscoErrorCode =
  | 'MATERIAL_NOT_FOUND'
  | 'DUPLICATE_MATERIAL_NAME'
  | 'JOB_NOT_FOUND'
  | 'E_INF_NEGATIVE'
  | 'BRANCH_E_NEGATIVE'
  | 'BRANCH_TAU_NONPOSITIVE'
  | 'WLF_DENOMINATOR_NONPOSITIVE'
  | 'NO_SEGMENTS'
  | 'TIME_NOT_STRICTLY_INCREASING'
  | 'SEGMENT_GAP_OR_OVERLAP'
  | 'FIRST_SEGMENT_NOT_LINEAR'
  | 'SINE_FREQUENCY_NONPOSITIVE'
  | 'SINE_CYCLES_NONPOSITIVE'
  | 'OUTPUT_GRID_EMPTY'
  | 'OUTPUT_GRID_NOT_INCREASING'
  | 'OUTPUT_GRID_OUT_OF_RANGE'
  | 'JOB_EMPTY'
  | 'INVALID_PAYLOAD';

export class ViscoError extends Error {
  constructor(
    public readonly code: ViscoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ViscoError';
  }
}
