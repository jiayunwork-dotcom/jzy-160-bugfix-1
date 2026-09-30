import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MaterialDocumentDefinition, MaterialSchema } from './persistence/material.schema';
import { JobDocumentDefinition, JobSchema } from './persistence/job.schema';
import { MaterialService } from './material/material.service';
import { JobService } from './job/job.service';
import { JobController, MaterialController } from './http/controllers';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MaterialDocumentDefinition.name, schema: MaterialSchema },
      { name: JobDocumentDefinition.name, schema: JobSchema },
    ]),
  ],
  controllers: [MaterialController, JobController],
  providers: [MaterialService, JobService],
  exports: [MaterialService, JobService],
})
export class ViscoModule {}
