# DebateAI - Project TODO

## Core Infrastructure
- [x] Database schema for debates, speeches, arguments, metrics
- [x] User authentication and session management
- [x] WebSocket/Socket.io setup for real-time features

## Debate Room Features
- [x] Live debate room creation and joining
- [x] Asian Parliamentary format support (2 teams, 3 debaters each)
- [x] Speaker order management (PM, DPM, GW, LO, DLO, OW, Reply)
- [x] Real-time participant presence tracking

## AI Motion Generation
- [x] Motion generation based on topic, difficulty, format
- [x] Background context and stakeholder generation
- [x] Topic categories (politics, ethics, tech, economics)

## Timekeeping & Moderation
- [x] Automated speaker announcements
- [x] Speech timer with protected time handling
- [x] POI (Points of Information) management
- [x] Rule violation detection and flagging

## Real-Time Transcription
- [x] WebRTC audio streaming setup
- [x] Speech-to-text transcription integration
- [x] Speaker label assignment
- [x] Timestamp segmentation

## Argument Mindmap
- [x] Argument extraction from transcripts
- [x] Interactive argument graph visualization
- [x] Relationship mapping (supports, rebuts, clashes)
- [x] Clickable nodes with transcript excerpts
- [x] Quality scoring for arguments

## Post-Debate Feedback
- [x] AI-powered feedback generation
- [x] Strongest arguments identification
- [x] Missed responses detection
- [x] Improvement suggestions (logic, clarity, weighing)
- [x] Debate summary and clash analysis

## Progress Tracking Dashboard
- [x] User metrics tracking (responsiveness, rebuttal quality)
- [x] Argument completeness scoring (claim-mechanism-impact)
- [x] Role fulfillment analysis
- [x] Historical trends visualization
- [x] Improvement tracking over time

## Notifications
- [ ] Email notifications for completed debates
- [ ] Performance summary notifications
- [ ] Milestone achievement alerts

## UI/UX (Brutalist Design)
- [x] Landing page with brutalist typography
- [x] Debate room interface
- [x] Transcript panel
- [x] Argument mindmap panel
- [x] Feedback dashboard
- [x] Progress tracking dashboard

## Testing
- [x] Unit tests for core functionality

## Testing Mode & AI Referee
- [x] Allow starting debate with any number of participants (testing mode)
- [x] AI referee with text-to-speech announcements
- [x] Speaker introductions and time announcements
- [x] Prepare for deployment

## Bug Fixes
- [ ] Fix room finding issue - users unable to find/join rooms

## Observer/Coach Mode Redesign
- [x] Fix Switch component crash (infinite loop)
- [ ] Redesign debate room for observer/coach perspective
- [ ] User watches two teams debate as 3rd party
- [ ] AI acts as automated referee/moderator
- [ ] AI announces speakers and manages time automatically
- [x] Solo testing mode - start debate without other participants

## Critical Bugs (User Reported)
- [x] Participants don't see each other in the room (sync issue)
- [x] Audio not being detected when speaking
- [x] Transcription not working

- [x] Fix useAIReferee infinite loop error (Maximum update depth exceeded)
- [x] Fix speech detection not working in debate room
- [x] Add audio level meter to show microphone input levels
- [ ] Push project to GitHub
- [x] Fix transcription not appearing on screen when speaking
- [x] Fix microphone permission not being requested
- [x] Add admin mode to play all speaker roles for testing
- [x] Add Test Microphone button to verify mic before starting debate
- [x] Fix microphone audio detection showing 0% level
- [x] Fix live audio transcription pipeline (compare with working reference repo)
- [x] Fix Whisper transcription outputting wrong language (should force English)
