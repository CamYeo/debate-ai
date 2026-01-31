import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { invokeLLM } from "./_core/llm";
import { transcribeAudio } from "./_core/voiceTranscription";
import * as db from "./db";

// Asian Parliamentary speaker order
const AP_SPEAKER_ORDER = ['pm', 'lo', 'dpm', 'dlo', 'gw', 'ow', 'pmr', 'lor'] as const;
const AP_SPEECH_TIMES = {
  pm: 7 * 60, // 7 minutes
  lo: 7 * 60,
  dpm: 7 * 60,
  dlo: 7 * 60,
  gw: 7 * 60,
  ow: 7 * 60,
  pmr: 4 * 60, // 4 minutes for reply
  lor: 4 * 60,
};
const PROTECTED_TIME = 60; // First and last minute protected from POIs

// Motion generation prompt
async function generateMotionWithAI(topic: string, difficulty: string, format: string) {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are an expert debate coach specializing in competitive parliamentary debate. Generate debate motions that are balanced, debatable, and appropriate for the specified difficulty level.
        
For novice: Use clear, relatable topics with obvious clash points.
For intermediate: Include nuanced policy debates with multiple stakeholders.
For advanced: Complex philosophical or technical topics requiring deep analysis.

Always respond in valid JSON format.`
      },
      {
        role: "user",
        content: `Generate a debate motion for:
- Topic area: ${topic}
- Difficulty: ${difficulty}
- Format: ${format}

Respond with JSON containing:
{
  "title": "The motion statement starting with 'This House...'",
  "backgroundContext": "2-3 sentences of relevant context",
  "stakeholders": ["list", "of", "key", "stakeholders"]
}`
      }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "motion",
        strict: true,
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            backgroundContext: { type: "string" },
            stakeholders: { type: "array", items: { type: "string" } }
          },
          required: ["title", "backgroundContext", "stakeholders"],
          additionalProperties: false
        }
      }
    }
  });
  
  const content = response.choices[0].message.content;
  return JSON.parse(typeof content === 'string' ? content : "{}");
}

// Argument extraction from transcript
async function extractArgumentsFromTranscript(transcript: string, team: string, speakerRole: string) {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are an expert debate analyst. Extract arguments from debate speeches, identifying claims, mechanisms, and impacts. Evaluate argument quality and identify whether arguments are new points, rebuttals, or extensions.`
      },
      {
        role: "user",
        content: `Analyze this ${team} team's ${speakerRole} speech transcript and extract all arguments:

"${transcript}"

Respond with JSON containing an array of arguments:
{
  "arguments": [
    {
      "type": "argument|rebuttal|extension",
      "claim": "The main assertion",
      "mechanism": "How/why this works",
      "impact": "Why this matters",
      "transcriptExcerpt": "Relevant quote from transcript",
      "qualityScore": 0.0-1.0,
      "strengthExplanation": "What makes this argument strong",
      "weaknessExplanation": "Potential weaknesses or gaps"
    }
  ]
}`
      }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "arguments",
        strict: true,
        schema: {
          type: "object",
          properties: {
            arguments: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["argument", "rebuttal", "extension"] },
                  claim: { type: "string" },
                  mechanism: { type: "string" },
                  impact: { type: "string" },
                  transcriptExcerpt: { type: "string" },
                  qualityScore: { type: "number" },
                  strengthExplanation: { type: "string" },
                  weaknessExplanation: { type: "string" }
                },
                required: ["type", "claim", "mechanism", "impact", "transcriptExcerpt", "qualityScore", "strengthExplanation", "weaknessExplanation"],
                additionalProperties: false
              }
            }
          },
          required: ["arguments"],
          additionalProperties: false
        }
      }
    }
  });
  
  const content = response.choices[0].message.content;
  return JSON.parse(typeof content === 'string' ? content : '{"arguments":[]}');
}

// Generate debate feedback
async function generateDebateFeedback(sessionData: any) {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are an expert debate coach providing constructive feedback. Analyze the debate and provide actionable insights for improvement.`
      },
      {
        role: "user",
        content: `Analyze this debate and provide comprehensive feedback:

Motion: ${sessionData.motion?.title || 'Unknown'}

Government Arguments:
${sessionData.arguments?.filter((a: any) => a.team === 'government').map((a: any) => `- ${a.claim}`).join('\n') || 'None recorded'}

Opposition Arguments:
${sessionData.arguments?.filter((a: any) => a.team === 'opposition').map((a: any) => `- ${a.claim}`).join('\n') || 'None recorded'}

Provide feedback in JSON format:
{
  "summary": "Overall debate summary",
  "strongestArguments": ["list of strongest arguments from both sides"],
  "missedResponses": ["arguments that weren't adequately addressed"],
  "improvementSuggestions": [{"area": "logic|clarity|weighing|engagement", "suggestion": "specific advice"}],
  "mainClashes": [{"topic": "clash point", "governmentPosition": "their stance", "oppositionPosition": "their stance", "winner": "government|opposition|draw"}],
  "overallScore": 0.0-1.0
}`
      }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "feedback",
        strict: true,
        schema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            strongestArguments: { type: "array", items: { type: "string" } },
            missedResponses: { type: "array", items: { type: "string" } },
            improvementSuggestions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  area: { type: "string" },
                  suggestion: { type: "string" }
                },
                required: ["area", "suggestion"],
                additionalProperties: false
              }
            },
            mainClashes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  topic: { type: "string" },
                  governmentPosition: { type: "string" },
                  oppositionPosition: { type: "string" },
                  winner: { type: "string" }
                },
                required: ["topic", "governmentPosition", "oppositionPosition", "winner"],
                additionalProperties: false
              }
            },
            overallScore: { type: "number" }
          },
          required: ["summary", "strongestArguments", "missedResponses", "improvementSuggestions", "mainClashes", "overallScore"],
          additionalProperties: false
        }
      }
    }
  });
  
  const content = response.choices[0].message.content;
  return JSON.parse(typeof content === 'string' ? content : "{}");
}

// Calculate user metrics from debate performance
async function calculateUserMetrics(userId: number, sessionId: number, participantData: any, sessionData: any) {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are an expert debate evaluator. Calculate performance metrics for a debater based on their speech and the overall debate.`
      },
      {
        role: "user",
        content: `Evaluate this debater's performance:

Role: ${participantData.speakerRole}
Team: ${participantData.team}

Their arguments:
${sessionData.arguments?.filter((a: any) => a.speechId === participantData.speechId).map((a: any) => `- ${a.claim} (Quality: ${a.qualityScore})`).join('\n') || 'None'}

Calculate metrics (0.0-1.0 scale) in JSON:
{
  "responsivenessScore": "How well they responded to opponent arguments",
  "rebuttalQuality": "Quality of their rebuttals",
  "argumentCompleteness": "Use of claim-mechanism-impact structure",
  "weighingUsage": "How well they weighed arguments",
  "roleFulfillment": "How well they fulfilled their speaker role",
  "overallPerformance": "Overall performance score"
}`
      }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "metrics",
        strict: true,
        schema: {
          type: "object",
          properties: {
            responsivenessScore: { type: "number" },
            rebuttalQuality: { type: "number" },
            argumentCompleteness: { type: "number" },
            weighingUsage: { type: "number" },
            roleFulfillment: { type: "number" },
            overallPerformance: { type: "number" }
          },
          required: ["responsivenessScore", "rebuttalQuality", "argumentCompleteness", "weighingUsage", "roleFulfillment", "overallPerformance"],
          additionalProperties: false
        }
      }
    }
  });
  
  const content = response.choices[0].message.content;
  return JSON.parse(typeof content === 'string' ? content : "{}");
}

export const appRouter = router({
  system: systemRouter,
  
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // Motion management
  motion: router({
    generate: protectedProcedure
      .input(z.object({
        topic: z.enum(["politics", "ethics", "technology", "economics", "social", "environment", "education", "health"]),
        difficulty: z.enum(["novice", "intermediate", "advanced"]),
        format: z.enum(["asian_parliamentary", "british_parliamentary", "world_schools"]).default("asian_parliamentary"),
      }))
      .mutation(async ({ input, ctx }) => {
        const generated = await generateMotionWithAI(input.topic, input.difficulty, input.format);
        
        const motionId = await db.createMotion({
          title: generated.title,
          topic: input.topic,
          difficulty: input.difficulty,
          format: input.format,
          backgroundContext: generated.backgroundContext,
          stakeholders: generated.stakeholders,
          createdBy: ctx.user.id,
          isAiGenerated: true,
        });
        
        return { id: motionId, ...generated };
      }),
    
    create: protectedProcedure
      .input(z.object({
        title: z.string().min(10),
        topic: z.enum(["politics", "ethics", "technology", "economics", "social", "environment", "education", "health"]),
        difficulty: z.enum(["novice", "intermediate", "advanced"]),
        format: z.enum(["asian_parliamentary", "british_parliamentary", "world_schools"]).default("asian_parliamentary"),
        backgroundContext: z.string().optional(),
        stakeholders: z.array(z.string()).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const motionId = await db.createMotion({
          ...input,
          createdBy: ctx.user.id,
          isAiGenerated: false,
        });
        return { id: motionId };
      }),
    
    list: protectedProcedure
      .input(z.object({
        topic: z.string().optional(),
        difficulty: z.string().optional(),
      }).optional())
      .query(async ({ input }) => {
        return await db.getMotions(input);
      }),
    
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return await db.getMotionById(input.id);
      }),
  }),

  // Debate session management
  debate: router({
    create: protectedProcedure
      .input(z.object({
        motionId: z.number().optional(),
        format: z.enum(["asian_parliamentary", "british_parliamentary", "world_schools"]).default("asian_parliamentary"),
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, roomCode } = await db.createDebateSession({
          motionId: input.motionId,
          format: input.format,
          createdBy: ctx.user.id,
        });
        return { id, roomCode };
      }),
    
    join: protectedProcedure
      .input(z.object({
        roomCode: z.string().length(8),
        team: z.enum(["government", "opposition"]),
        speakerRole: z.enum(["pm", "dpm", "gw", "lo", "dlo", "ow", "pmr", "lor"]),
      }))
      .mutation(async ({ input, ctx }) => {
        const session = await db.getDebateSessionByRoomCode(input.roomCode);
        if (!session) throw new Error("Debate room not found");
        if (session.status !== "waiting") throw new Error("Debate has already started or ended");
        
        // Check if role is already taken
        const participants = await db.getSessionParticipants(session.id);
        const roleTaken = participants.some(p => p.team === input.team && p.speakerRole === input.speakerRole);
        if (roleTaken) throw new Error("This role is already taken");
        
        // Check if user already joined
        const existingParticipant = await db.getParticipantByUserAndSession(ctx.user.id, session.id);
        if (existingParticipant) throw new Error("You have already joined this debate");
        
        const participantId = await db.addParticipant({
          sessionId: session.id,
          userId: ctx.user.id,
          team: input.team,
          speakerRole: input.speakerRole,
        });
        
        return { participantId, sessionId: session.id };
      }),
    
    start: protectedProcedure
      .input(z.object({ 
        sessionId: z.number(),
        testingMode: z.boolean().optional().default(false),
      }))
      .mutation(async ({ input, ctx }) => {
        const session = await db.getDebateSessionById(input.sessionId);
        if (!session) throw new Error("Session not found");
        if (session.createdBy !== ctx.user.id) throw new Error("Only the creator can start the debate");
        if (session.status !== "waiting") throw new Error("Debate cannot be started");
        
        const participants = await db.getSessionParticipants(input.sessionId);
        
        // In testing mode, allow starting with any number of participants
        if (!input.testingMode && participants.length < 6) {
          throw new Error("Need 6 participants to start (3 per team). Enable testing mode to start with fewer.");
        }
        
        await db.updateDebateSession(input.sessionId, {
          status: "in_progress",
          startedAt: new Date(),
          currentSpeakerIndex: 0,
          currentSpeakerStartTime: new Date(),
        });
        
        return { success: true, testingMode: input.testingMode };
      }),
    
    end: protectedProcedure
      .input(z.object({ sessionId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const session = await db.getDebateSessionById(input.sessionId);
        if (!session) throw new Error("Session not found");
        
        await db.updateDebateSession(input.sessionId, {
          status: "completed",
          endedAt: new Date(),
        });
        
        // Generate feedback
        const sessionData = await db.getDebateSessionWithDetails(input.sessionId);
        if (sessionData) {
          const feedback = await generateDebateFeedback(sessionData);
          await db.createDebateFeedback({
            sessionId: input.sessionId,
            feedbackType: "session",
            ...feedback,
          });
        }
        
        return { success: true };
      }),
    
    get: protectedProcedure
      .input(z.object({ sessionId: z.number() }))
      .query(async ({ input }) => {
        return await db.getDebateSessionWithDetails(input.sessionId);
      }),
    
    getByRoomCode: protectedProcedure
      .input(z.object({ roomCode: z.string() }))
      .query(async ({ input }) => {
        const session = await db.getDebateSessionByRoomCode(input.roomCode);
        if (!session) return null;
        return await db.getDebateSessionWithDetails(session.id);
      }),
    
    myDebates: protectedProcedure.query(async ({ ctx }) => {
      return await db.getUserDebateSessions(ctx.user.id);
    }),
    
    advanceSpeaker: protectedProcedure
      .input(z.object({ sessionId: z.number() }))
      .mutation(async ({ input }) => {
        const session = await db.getDebateSessionById(input.sessionId);
        if (!session) throw new Error("Session not found");
        if (session.status !== "in_progress") throw new Error("Debate is not in progress");
        
        const nextIndex = session.currentSpeakerIndex + 1;
        if (nextIndex >= AP_SPEAKER_ORDER.length) {
          // Debate finished
          await db.updateDebateSession(input.sessionId, {
            status: "completed",
            endedAt: new Date(),
          });
          return { finished: true, nextSpeaker: null };
        }
        
        await db.updateDebateSession(input.sessionId, {
          currentSpeakerIndex: nextIndex,
          currentSpeakerStartTime: new Date(),
        });
        
        return { finished: false, nextSpeaker: AP_SPEAKER_ORDER[nextIndex] };
      }),
  }),

  // Speech and transcription
  speech: router({
    create: protectedProcedure
      .input(z.object({
        sessionId: z.number(),
        speakerRole: z.enum(["pm", "dpm", "gw", "lo", "dlo", "ow", "pmr", "lor"]),
      }))
      .mutation(async ({ input, ctx }) => {
        const participant = await db.getParticipantByUserAndSession(ctx.user.id, input.sessionId);
        if (!participant) throw new Error("You are not a participant in this debate");
        
        const speechId = await db.createSpeech({
          sessionId: input.sessionId,
          participantId: participant.id,
          speakerRole: input.speakerRole,
          startedAt: new Date(),
        });
        
        return { speechId };
      }),
    
    updateTranscript: protectedProcedure
      .input(z.object({
        speechId: z.number(),
        transcript: z.string(),
      }))
      .mutation(async ({ input }) => {
        await db.updateSpeech(input.speechId, { transcript: input.transcript });
        return { success: true };
      }),
    
    end: protectedProcedure
      .input(z.object({
        speechId: z.number(),
        audioUrl: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const speech = await db.getSpeechById(input.speechId);
        if (!speech) throw new Error("Speech not found");
        
        const duration = speech.startedAt 
          ? Math.floor((Date.now() - speech.startedAt.getTime()) / 1000)
          : 0;
        
        await db.updateSpeech(input.speechId, {
          endedAt: new Date(),
          duration,
          audioUrl: input.audioUrl,
        });
        
        // Extract arguments from transcript
        if (speech.transcript) {
          const session = await db.getDebateSessionById(speech.sessionId);
          const participants = await db.getSessionParticipants(speech.sessionId);
          const participant = participants.find(p => p.id === speech.participantId);
          
          if (participant) {
            const extracted = await extractArgumentsFromTranscript(
              speech.transcript,
              participant.team,
              speech.speakerRole
            );
            
            for (const arg of extracted.arguments) {
              await db.createArgument({
                sessionId: speech.sessionId,
                speechId: input.speechId,
                team: participant.team,
                type: arg.type,
                claim: arg.claim,
                mechanism: arg.mechanism,
                impact: arg.impact,
                transcriptExcerpt: arg.transcriptExcerpt,
                qualityScore: arg.qualityScore,
                strengthExplanation: arg.strengthExplanation,
                weaknessExplanation: arg.weaknessExplanation,
              });
            }
          }
        }
        
        return { success: true, duration };
      }),
    
    transcribe: protectedProcedure
      .input(z.object({
        audioUrl: z.string(),
        speechId: z.number(),
      }))
      .mutation(async ({ input }) => {
        const result = await transcribeAudio({
          audioUrl: input.audioUrl,
          language: "en",
        });
        
        if ('error' in result) {
          throw new Error(result.error);
        }
        
        // Save transcript
        await db.updateSpeech(input.speechId, { transcript: result.text });
        
        // Save segments
        if (result.segments) {
          for (const segment of result.segments) {
            await db.addTranscriptSegment({
              speechId: input.speechId,
              text: segment.text,
              startTime: segment.start,
              endTime: segment.end,
              confidence: segment.avg_logprob ? Math.exp(segment.avg_logprob) : undefined,
            });
          }
        }
        
        return { transcript: result.text, segments: result.segments };
      }),
    
    // New endpoint that accepts base64 audio data directly
    transcribeAudio: protectedProcedure
      .input(z.object({
        audioData: z.string(), // Base64 encoded audio
        speechId: z.number().optional(),
        sessionId: z.number(),
        speakerRole: z.string(),
        timestamp: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        try {
          // Decode base64 audio
          const audioBuffer = Buffer.from(input.audioData, 'base64');
          
          // Check minimum size (skip tiny chunks)
          if (audioBuffer.length < 1000) {
            return { transcript: '', segments: [] };
          }
          
          // Upload to S3
          const { storagePut } = await import('./storage');
          const fileName = `audio/${input.sessionId}/${input.speakerRole}/${Date.now()}.webm`;
          const { url: audioUrl } = await storagePut(fileName, audioBuffer, 'audio/webm');
          
          console.log('[Transcribe] Uploaded audio to:', audioUrl);
          
          // Transcribe using Whisper
          const result = await transcribeAudio({
            audioUrl,
            language: "en",
            prompt: "Transcribe this debate speech. Focus on clarity and accuracy.",
          });
          
          // Check if it's an error response
          if ('error' in result) {
            console.error('[Transcribe] Error:', result.error);
            return { transcript: '', segments: [] };
          }
          
          console.log('[Transcribe] Got transcript:', result.text?.substring(0, 100));
          
          // If we have a speechId, append to existing transcript
          if (input.speechId) {
            const speech = await db.getSpeechById(input.speechId);
            const existingTranscript = speech?.transcript || '';
            const newTranscript = existingTranscript 
              ? `${existingTranscript} ${result.text}` 
              : result.text;
            
            await db.updateSpeech(input.speechId, {
              transcript: newTranscript,
              audioUrl,
            });
          }
          
          return { 
            transcript: result.text || '',
            segments: result.segments || [],
          };
        } catch (error: any) {
          console.error('[Transcribe] Error:', error);
          return { transcript: '', segments: [] };
        }
      }),
    
    addSegment: protectedProcedure
      .input(z.object({
        speechId: z.number(),
        text: z.string(),
        startTime: z.number(),
        endTime: z.number(),
        confidence: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const segmentId = await db.addTranscriptSegment(input);
        return { segmentId };
      }),
  }),

  // Arguments and mindmap
  argument: router({
    list: protectedProcedure
      .input(z.object({ sessionId: z.number() }))
      .query(async ({ input }) => {
        const args = await db.getSessionArguments(input.sessionId);
        const relationships = await db.getSessionArgumentRelationships(input.sessionId);
        return { arguments: args, relationships };
      }),
    
    createRelationship: protectedProcedure
      .input(z.object({
        sessionId: z.number(),
        sourceArgumentId: z.number(),
        targetArgumentId: z.number(),
        relationshipType: z.enum(["supports", "rebuts", "clashes", "extends"]),
        strength: z.number().min(0).max(1).optional(),
      }))
      .mutation(async ({ input }) => {
        const relationshipId = await db.createArgumentRelationship(input);
        return { relationshipId };
      }),
    
    analyzeClashes: protectedProcedure
      .input(z.object({ sessionId: z.number() }))
      .mutation(async ({ input }) => {
        const args = await db.getSessionArguments(input.sessionId);
        const govArgs = args.filter(a => a.team === 'government');
        const oppArgs = args.filter(a => a.team === 'opposition');
        
        // Use AI to identify clashes
        const response = await invokeLLM({
          messages: [
            {
              role: "system",
              content: "You are an expert debate analyst. Identify clashes between government and opposition arguments."
            },
            {
              role: "user",
              content: `Analyze these arguments and identify clashes:

Government Arguments:
${govArgs.map((a, i) => `${i + 1}. [ID:${a.id}] ${a.claim}`).join('\n')}

Opposition Arguments:
${oppArgs.map((a, i) => `${i + 1}. [ID:${a.id}] ${a.claim}`).join('\n')}

Return JSON with clash relationships:
{
  "clashes": [
    {"sourceId": <gov_arg_id>, "targetId": <opp_arg_id>, "strength": 0.0-1.0}
  ]
}`
            }
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "clashes",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  clashes: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        sourceId: { type: "number" },
                        targetId: { type: "number" },
                        strength: { type: "number" }
                      },
                      required: ["sourceId", "targetId", "strength"],
                      additionalProperties: false
                    }
                  }
                },
                required: ["clashes"],
                additionalProperties: false
              }
            }
          }
        });
        
        const content = response.choices[0].message.content;
        const result = JSON.parse(typeof content === 'string' ? content : '{"clashes":[]}');
        
        // Create relationships
        for (const clash of result.clashes) {
          await db.createArgumentRelationship({
            sessionId: input.sessionId,
            sourceArgumentId: clash.sourceId,
            targetArgumentId: clash.targetId,
            relationshipType: "clashes",
            strength: clash.strength,
          });
        }
        
        return result;
      }),
  }),

  // POI management
  poi: router({
    offer: protectedProcedure
      .input(z.object({
        sessionId: z.number(),
        targetSpeechId: z.number(),
        timestamp: z.number(),
      }))
      .mutation(async ({ input, ctx }) => {
        const participant = await db.getParticipantByUserAndSession(ctx.user.id, input.sessionId);
        if (!participant) throw new Error("You are not a participant");
        
        const poiId = await db.createPOI({
          sessionId: input.sessionId,
          offeredById: participant.id,
          targetSpeechId: input.targetSpeechId,
          timestamp: input.timestamp,
          wasAccepted: false,
        });
        
        return { poiId };
      }),
    
    respond: protectedProcedure
      .input(z.object({
        poiId: z.number(),
        accepted: z.boolean(),
        content: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        // This would update the POI - simplified for now
        return { success: true };
      }),
    
    list: protectedProcedure
      .input(z.object({ sessionId: z.number() }))
      .query(async ({ input }) => {
        return await db.getSessionPOIs(input.sessionId);
      }),
  }),

  // Rule violations
  violation: router({
    report: protectedProcedure
      .input(z.object({
        sessionId: z.number(),
        speechId: z.number().optional(),
        violationType: z.enum(["new_argument_in_reply", "time_exceeded", "poi_during_protected", "speaking_out_of_turn"]),
        description: z.string().optional(),
        timestamp: z.number().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const participant = await db.getParticipantByUserAndSession(ctx.user.id, input.sessionId);
        
        const violationId = await db.createRuleViolation({
          sessionId: input.sessionId,
          speechId: input.speechId,
          participantId: participant?.id,
          violationType: input.violationType,
          description: input.description,
          timestamp: input.timestamp,
        });
        
        return { violationId };
      }),
    
    list: protectedProcedure
      .input(z.object({ sessionId: z.number() }))
      .query(async ({ input }) => {
        return await db.getSessionRuleViolations(input.sessionId);
      }),
  }),

  // Feedback
  feedback: router({
    get: protectedProcedure
      .input(z.object({ sessionId: z.number() }))
      .query(async ({ input }) => {
        return await db.getSessionFeedback(input.sessionId);
      }),
    
    generate: protectedProcedure
      .input(z.object({ sessionId: z.number() }))
      .mutation(async ({ input }) => {
        const sessionData = await db.getDebateSessionWithDetails(input.sessionId);
        if (!sessionData) throw new Error("Session not found");
        
        const feedback = await generateDebateFeedback(sessionData);
        
        const feedbackId = await db.createDebateFeedback({
          sessionId: input.sessionId,
          feedbackType: "session",
          summary: feedback.summary,
          strongestArguments: feedback.strongestArguments,
          missedResponses: feedback.missedResponses,
          improvementSuggestions: feedback.improvementSuggestions,
          mainClashes: feedback.mainClashes,
          overallScore: feedback.overallScore,
        });
        
        return { feedbackId, ...feedback };
      }),
  }),

  // User metrics and progress
  metrics: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      return await db.getUserProgressStats(ctx.user.id);
    }),
    
    getForSession: protectedProcedure
      .input(z.object({ sessionId: z.number() }))
      .query(async ({ input, ctx }) => {
        return await db.getUserMetricsForSession(ctx.user.id, input.sessionId);
      }),
    
    calculate: protectedProcedure
      .input(z.object({ sessionId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const sessionData = await db.getDebateSessionWithDetails(input.sessionId);
        if (!sessionData) throw new Error("Session not found");
        
        const participant = sessionData.participants.find(p => p.userId === ctx.user.id);
        if (!participant) throw new Error("You were not a participant");
        
        const metrics = await calculateUserMetrics(ctx.user.id, input.sessionId, participant, sessionData);
        
        const metricId = await db.createUserMetric({
          userId: ctx.user.id,
          sessionId: input.sessionId,
          speakerRole: participant.speakerRole,
          ...metrics,
        });
        
        return { metricId, ...metrics };
      }),
  }),

  // Debate format info
  format: router({
    getAPInfo: publicProcedure.query(() => ({
      name: "Asian Parliamentary",
      teams: 2,
      speakersPerTeam: 3,
      speakerOrder: AP_SPEAKER_ORDER,
      speechTimes: AP_SPEECH_TIMES,
      protectedTime: PROTECTED_TIME,
      roles: {
        pm: { name: "Prime Minister", team: "government", duties: "Define motion, present case" },
        lo: { name: "Leader of Opposition", team: "opposition", duties: "Rebut PM, present counter-case" },
        dpm: { name: "Deputy Prime Minister", team: "government", duties: "Rebut LO, extend case" },
        dlo: { name: "Deputy Leader of Opposition", team: "opposition", duties: "Rebut DPM, extend counter-case" },
        gw: { name: "Government Whip", team: "government", duties: "Summarize, weigh arguments" },
        ow: { name: "Opposition Whip", team: "opposition", duties: "Summarize, weigh arguments" },
        pmr: { name: "PM Reply", team: "government", duties: "Biased summary, no new arguments" },
        lor: { name: "LO Reply", team: "opposition", duties: "Biased summary, no new arguments" },
      },
    })),
  }),
});

export type AppRouter = typeof appRouter;
