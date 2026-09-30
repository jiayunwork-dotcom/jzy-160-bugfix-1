import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { ViscoError, ViscoErrorCode } from '../common/errors';

const STATUS_BY_CODE: Record<ViscoErrorCode, HttpStatus> = {
  MATERIAL_NOT_FOUND: HttpStatus.NOT_FOUND,
  DUPLICATE_MATERIAL_NAME: HttpStatus.CONFLICT,
  JOB_NOT_FOUND: HttpStatus.NOT_FOUND,
  E_INF_NEGATIVE: HttpStatus.UNPROCESSABLE_ENTITY,
  BRANCH_E_NEGATIVE: HttpStatus.UNPROCESSABLE_ENTITY,
  BRANCH_TAU_NONPOSITIVE: HttpStatus.UNPROCESSABLE_ENTITY,
  WLF_DENOMINATOR_NONPOSITIVE: HttpStatus.UNPROCESSABLE_ENTITY,
  NO_SEGMENTS: HttpStatus.UNPROCESSABLE_ENTITY,
  TIME_NOT_STRICTLY_INCREASING: HttpStatus.UNPROCESSABLE_ENTITY,
  SEGMENT_GAP_OR_OVERLAP: HttpStatus.UNPROCESSABLE_ENTITY,
  FIRST_SEGMENT_NOT_LINEAR: HttpStatus.UNPROCESSABLE_ENTITY,
  SINE_FREQUENCY_NONPOSITIVE: HttpStatus.UNPROCESSABLE_ENTITY,
  SINE_CYCLES_NONPOSITIVE: HttpStatus.UNPROCESSABLE_ENTITY,
  OUTPUT_GRID_EMPTY: HttpStatus.UNPROCESSABLE_ENTITY,
  OUTPUT_GRID_NOT_INCREASING: HttpStatus.UNPROCESSABLE_ENTITY,
  OUTPUT_GRID_OUT_OF_RANGE: HttpStatus.UNPROCESSABLE_ENTITY,
  JOB_EMPTY: HttpStatus.BAD_REQUEST,
  INVALID_PAYLOAD: HttpStatus.BAD_REQUEST,
};

/** 领域错误 → 统一 JSON：{ statusCode, errorCode, message }。 */
@Catch(ViscoError)
export class ViscoExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ViscoExceptionFilter.name);

  catch(exception: ViscoError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
    if (status >= 500) {
      this.logger.error(exception.message, exception.stack);
    }
    response.status(status).json({
      statusCode: status,
      errorCode: exception.code,
      message: exception.message,
    });
  }
}
