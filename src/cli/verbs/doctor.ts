import { z } from 'zod'
import { runChecks } from '../../broker/doctor.js'
import { describeDoctor } from '../doctor.js'
import { defineVerb, Report } from '../command.js'

export const doctorVerb = defineVerb({
  name: 'doctor',
  description: 'check the things that fail silently',
  args: z.object({}),
  result: Report,
  async run() {
    return describeDoctor(await runChecks())
  },
})
