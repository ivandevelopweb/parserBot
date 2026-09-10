import 'dotenv/config';
import { relative, resolve } from 'node:path';

import {
  CLASSROOM_HOME_URL,
  CLASSROOM_ORIGIN,
  CLASSROOM_RPC_CONTENT_TYPE,
  CLASSROOM_RPC_ID,
  CLASSROOM_TURNED_IN_STATES,
  createClassroomWebClient,
} from './classroom-web.js';
import { errorMessage } from './utils.js';

const VALIDATION_COURSE_ID = '544644036115';
const VALIDATION_ASSIGNMENT_ID = '878109743041';

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function createDebugRun() {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const runId = `run-${now.getTime()}-${process.pid}`;
  return {
    id: runId,
    artifactPath: resolve(process.cwd(), 'data', `classroom-pONvgf-response.${timestamp}-${runId}.debug.txt`),
  };
}

function artifactLabel(filePath) {
  if (!filePath) {
    return 'unknown';
  }
  return relative(process.cwd(), filePath).replaceAll('\\', '/');
}

function printPageDiagnostics(diagnostics) {
  const safe = diagnostics ?? {
    status: 'unknown',
    finalUrl: 'unknown',
    contentType: 'unknown',
    responseLength: 'unknown',
    looksLikeGoogleLogin: false,
    looksLikeClassroom: false,
    redirectChain: [],
  };
  console.log(`[classroom-debug] GET status: ${safe.status}`);
  console.log(`[classroom-debug] final URL after redirects: ${safe.finalUrl}`);
  console.log(`[classroom-debug] content-type: ${safe.contentType}`);
  console.log(`[classroom-debug] response length: ${safe.responseLength}`);
  console.log(`[classroom-debug] looks like Google login: ${yesNo(safe.looksLikeGoogleLogin)}`);
  console.log(`[classroom-debug] looks like Classroom: ${yesNo(safe.looksLikeClassroom)}`);
  if (safe.redirectChain?.length > 1) {
    console.log(`[classroom-debug] redirect chain: ${safe.redirectChain.join(' -> ')}`);
  }
}

function printRpcDiagnostics(diagnostics) {
  const safe = diagnostics ?? {
    status: 'unknown',
    contentType: 'unknown',
    rawResponseLength: 'unknown',
    firstFrameLength: 'unknown',
    firstFrameActualLength: 'unknown',
    firstFrameLengthMode: 'unknown',
    firstFramePrefix: 'unknown',
    wrbFrFramesCount: 'unknown',
    rpcIds: [],
    payloadFieldType: 'unknown',
    request: {},
    cookies: {},
  };
  const request = safe.request ?? {};
  const cookies = safe.cookies ?? {};
  const requestHeaders = request.headers ?? {};
  const body = request.body ?? {};
  const firstFrameLength = safe.firstFrameLength ?? 'unframed';
  const firstFrameActualLength = safe.firstFrameActualLength ?? 'unknown';
  console.log(`[classroom-rpc-debug] run id: ${safe.debugRunId ?? 'unknown'}`);
  console.log(`[classroom-rpc-debug] raw artifact: ${artifactLabel(safe.debugArtifactPath)}`);
  console.log(`[classroom-rpc-debug] status: ${safe.status}`);
  console.log(`[classroom-rpc-debug] response content-type: ${safe.contentType}`);
  console.log(`[classroom-rpc-debug] raw response length: ${safe.rawResponseLength}`);
  console.log(
    `[classroom-rpc-debug] first frame length/prefix: ${firstFrameLength}`
      + ` (actual ${firstFrameActualLength}, ${safe.firstFrameLengthMode}, ${safe.firstFramePrefix})`,
  );
  console.log(`[classroom-rpc-debug] wrb.fr frames count: ${safe.wrbFrFramesCount}`);
  console.log(`[classroom-rpc-debug] rpc ids found in response: ${safe.rpcIds?.join(', ') || 'none'}`);
  console.log(`[classroom-rpc-debug] payload field type for pONvgf: ${safe.payloadFieldType}`);
  console.log(`[classroom-rpc-debug] rpcid: ${request.rpcid ?? 'unknown'}`);
  console.log(`[classroom-rpc-debug] source-path: ${request.sourcePath ?? 'unknown'}`);
  console.log(`[classroom-rpc-debug] f.req length: ${request.fReqLength ?? 'unknown'}`);
  console.log(`[classroom-rpc-debug] f.req contains courseId: ${yesNo(request.fReqContainsCourseId)}`);
  console.log(`[classroom-rpc-debug] form body length: ${request.formBodyLength ?? 'unknown'}`);
  console.log(`[classroom-rpc-debug] at configured: ${yesNo(request.atConfigured)}`);
  console.log(`[classroom-rpc-debug] f.sid configured: ${yesNo(request.fSidConfigured)}`);
  console.log(`[classroom-rpc-debug] bl configured: ${yesNo(request.blConfigured)}`);
  console.log(`[classroom-rpc-debug] GET cookie count: ${cookies.get?.count ?? 'unknown'}`);
  console.log(`[classroom-rpc-debug] POST cookie count: ${cookies.post?.count ?? 'unknown'}`);
  console.log(`[classroom-rpc-debug] GET cookie header length: ${cookies.get?.length ?? 'unknown'}`);
  console.log(`[classroom-rpc-debug] POST cookie header length: ${cookies.post?.length ?? 'unknown'}`);
  console.log(`[classroom-rpc-debug] cookie name sets identical: ${yesNo(cookies.sameNames)}`);
  console.log(`[classroom-rpc-debug] full GET/POST Cookie header identical: ${yesNo(cookies.sameHeader)}`);

  if (safe.payloadFieldType === 'null') {
    printRequestComparison({ ...safe, request: { ...request, headers: requestHeaders, body } });
  }
}

function printDecodeDiagnostics(result) {
  const rawMatches = result?.rawMatches ?? {};
  const matches = result?.decodeDiagnostics?.matches ?? {};
  const contexts = result?.decodeDiagnostics?.contexts ?? [];
  const pathsFor = (kind) => matches[kind]?.paths ?? [];

  console.log(
    `[classroom-decode-debug] assignmentId in raw payload string: ${yesNo(rawMatches.assignmentId)}`,
  );
  console.log(
    `[classroom-decode-debug] courseId in raw payload string: ${yesNo(rawMatches.courseId)}`,
  );
  console.log(
    `[classroom-decode-debug] title fragment in raw payload string: ${yesNo(rawMatches.titleFragment)}`,
  );
  console.log(`[classroom-decode-debug] assignmentId found: ${yesNo(matches.assignmentId?.found)}`);
  console.log(`[classroom-decode-debug] courseId found: ${yesNo(matches.courseId?.found)}`);
  console.log(`[classroom-decode-debug] title fragment found: ${yesNo(matches.titleFragment?.found)}`);

  for (const [label, kind] of [
    ['assignmentId', 'assignmentId'],
    ['courseId', 'courseId'],
    ['title fragment', 'titleFragment'],
  ]) {
    const paths = pathsFor(kind);
    if (paths.length > 0) {
      console.log(`[classroom-decode-debug] ${label} paths: ${paths.join(', ')}`);
    }
  }

  for (const context of contexts) {
    const neighbours = context.neighbours
      .map(({ index, type }) => `${index}:${type}`)
      .join(', ') || 'none';
    console.log(`[classroom-decode-debug] assignment parent array path: ${context.parentPath}`);
    console.log(`[classroom-decode-debug] assignment parent array length: ${context.parentLength}`);
    console.log(`[classroom-decode-debug] assignment neighbouring fields: ${neighbours}`);
    console.log(`[classroom-decode-debug] assignment matched field index: ${context.matchedIndex}`);
  }
}

function printRequestComparison(diagnostics) {
  const request = diagnostics.request ?? {};
  const query = request.query ?? {};
  const headers = request.headers ?? {};
  const body = request.body ?? {};
  const rows = [
    ['query rpcids', query.rpcids?.browser ?? 'pONvgf', query.rpcids?.node ?? 'unknown', query.rpcids?.matches],
    ['query source-path', query.sourcePath?.browser ?? '/a/not-turned-in/all', query.sourcePath?.node ?? 'unknown', query.sourcePath?.matches],
    ['query f.sid', query.fSid?.browser ?? 'current authenticated bootstrap', query.fSid?.node ?? 'configured', query.fSid?.matches],
    ['query bl', query.bl?.browser ?? 'current Classroom bootstrap', query.bl?.node ?? 'configured', query.bl?.matches],
    ['query hl', query.hl?.browser ?? 'uk', query.hl?.node ?? 'unknown', query.hl?.matches],
    ['query soc-app', query.socApp?.browser ?? '1', query.socApp?.node ?? 'unknown', query.socApp?.matches],
    ['query soc-platform', query.socPlatform?.browser ?? '1', query.socPlatform?.node ?? 'unknown', query.socPlatform?.matches],
    ['query soc-device', query.socDevice?.browser ?? '2', query.socDevice?.node ?? 'unknown', query.socDevice?.matches],
    ['query _reqid', query.reqid?.browser ?? 'generated per request', query.reqid?.node ?? 'generated', query.reqid?.matches],
    ['query rt', query.rt?.browser ?? 'c', query.rt?.node ?? 'unknown', query.rt?.matches],
    ['bootstrap freshness', 'current authenticated page', request.bootstrapFromAuthenticatedPage ? 'current authenticated page' : 'not proven', request.bootstrapFromAuthenticatedPage],
    ['header Origin', CLASSROOM_ORIGIN, headers.originExact ? 'exact' : 'mismatch', headers.originExact],
    ['header Referer', CLASSROOM_HOME_URL, headers.refererExact ? 'exact' : 'mismatch', headers.refererExact],
    ['header Content-Type', CLASSROOM_RPC_CONTENT_TYPE, headers.contentTypeExact ? 'exact' : 'mismatch', headers.contentTypeExact],
    ['header X-Same-Domain', '1 (if present in Chrome)', headers.sameDomain ? '1' : 'missing/mismatch', headers.sameDomain],
    ['header Accept', 'browser-like', headers.acceptConfigured ? 'configured' : 'missing', headers.acceptConfigured],
    ['header User-Agent', 'browser-like', headers.userAgentConfigured ? 'configured' : 'missing', headers.userAgentConfigured],
    ['body f.req wrapper/payload', 'known batchexecute shape', body.fReqWrapperMatches ? 'matches' : 'mismatch', body.fReqWrapperMatches],
    ['body f.req encoding', 'form-urlencoded once', body.fReqEncodedOnce ? 'once' : 'not once', body.fReqEncodedOnce],
    ['body f.req courseId', 'present', yesNo(request.fReqContainsCourseId), request.fReqContainsCourseId],
  ];

  console.log('[classroom-rpc-debug] browser vs Node comparison:');
  for (const [label, browser, node, matches] of rows) {
    console.log(
      `[classroom-rpc-debug] ${label} | browser: ${browser} | Node: ${node} | match: ${yesNo(matches)}`,
    );
  }
}

function printAssignment(assignment, index) {
  console.log(`\n[Classroom] assignment ${index + 1}`);
  console.log(`assignmentId: ${assignment.assignmentId}`);
  console.log(`courseId: ${assignment.courseId}`);
  console.log(`title: ${assignment.title || '—'}`);
  console.log(`description: ${assignment.description || '—'}`);
  console.log(`dueAt: ${assignment.dueAt || '—'}`);
}

async function main() {
  const courseId = String(process.env.CLASSROOM_COURSE_ID || VALIDATION_COURSE_ID).trim();
  const debugRun = createDebugRun();
  const client = createClassroomWebClient();
  const cookieDiagnostics = client.getCookieHeaderDiagnostics();
  console.log(`[classroom-debug] cookie header configured: ${yesNo(cookieDiagnostics.configured)}`);
  console.log(`[classroom-debug] cookie header length: ${cookieDiagnostics.length}`);

  let page;
  try {
    page = await client.getAuthenticatedPage();
  } finally {
    printPageDiagnostics(client.getLastDiagnostics());
  }

  console.log('[Classroom] authenticated');
  console.log(`[Classroom] bootstrap OK (source: ${page.bootstrap.source})`);

  let rpcResult;
  try {
    rpcResult = await client.getCourseWorkForCourse(courseId, {
      debug: true,
      debugRunId: debugRun.id,
      debugArtifactPath: debugRun.artifactPath,
      displayStates: CLASSROOM_TURNED_IN_STATES,
      debugTargets: {
        assignmentId: VALIDATION_ASSIGNMENT_ID,
        courseId: VALIDATION_COURSE_ID,
        titleFragment: '11.09 Кайдашева',
      },
    });
  } finally {
    printRpcDiagnostics(client.getLastRpcDiagnostics());
  }
  const assignments = rpcResult.assignments;
  console.log(`[Classroom] ${CLASSROOM_RPC_ID} 200 OK`);
  console.log(`[Classroom] assignments: ${assignments.length}`);
  printDecodeDiagnostics(rpcResult);

  assignments.slice(0, 5).forEach(printAssignment);

  const validationAssignment = assignments.find((assignment) => (
    String(assignment.courseId) === VALIDATION_COURSE_ID
    && String(assignment.assignmentId) === VALIDATION_ASSIGNMENT_ID
    && String(assignment.title ?? '').startsWith('11.09 Кайдашева сім’я')
  ));

  if (validationAssignment) {
    console.log(`[Classroom] assignment ${VALIDATION_ASSIGNMENT_ID}: FOUND`);
    console.log(`title: ${validationAssignment.title}`);
    return;
  }

  console.error(`[Classroom] assignment ${VALIDATION_ASSIGNMENT_ID}: NOT FOUND`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[fatal] ${errorMessage(error)}`);
  process.exitCode = 1;
});
