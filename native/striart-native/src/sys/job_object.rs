//! Job Object Windows `KILL_ON_JOB_CLOSE` : conteneur de process partagé
//! par `job run` (Test Gate) et l'hôte de pty (le shell et toute sa
//! descendance meurent avec l'hôte, même tué brutalement).

use super::OwnedHandle;
use crate::protocol::NativeError;
use std::ffi::c_void;
use std::mem::{offset_of, size_of, zeroed};
use std::ptr::null;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, GetLastError};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject,
};

/// Code de sortie imposé aux process du job tués par nous.
pub const KILLED_EXIT_CODE: u32 = 1;
/// Attente de la mort effective du job après `TerminateJobObject`.
const TERMINATE_WAIT: Duration = Duration::from_secs(5);
/// Intervalle de vérification pendant cette attente.
const TERMINATE_POLL: Duration = Duration::from_millis(20);

pub fn create_job() -> Result<OwnedHandle, NativeError> {
    // SAFETY: pas d'attributs de sécurité ni de nom (job anonyme).
    let job = OwnedHandle::new(unsafe { CreateJobObjectW(null(), null()) })
        .ok_or_else(|| NativeError::os("JOB_CREATE_FAILED", "CreateJobObjectW"))?;
    // SAFETY: structure C sans invariant ; zéro = aucune limite.
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: job valide ; pointeur et taille de la structure attendue.
    let ok = unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast::<c_void>(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if ok == 0 {
        return Err(NativeError::os(
            "JOB_CREATE_FAILED",
            "SetInformationJobObject",
        ));
    }
    Ok(job)
}

pub fn active_processes(job: &OwnedHandle) -> u32 {
    // SAFETY: structure C sans invariant.
    let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
    // SAFETY: job valide ; tampon de la taille de la structure.
    let ok = unsafe {
        QueryInformationJobObject(
            job.0,
            JobObjectBasicAccountingInformation,
            (&raw mut info).cast::<c_void>(),
            size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            std::ptr::null_mut(),
        )
    };
    // Lecture impossible : on suppose le job encore peuplé (fail closed —
    // l'appelant tuera et attendra plutôt que de déclarer « aucun orphelin »).
    if ok == 0 {
        u32::MAX
    } else {
        info.ActiveProcesses
    }
}

/// PID des process vivants du job.
pub fn job_pids(job: &OwnedHandle) -> Result<Vec<u32>, NativeError> {
    let list_offset = offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList);
    let mut capacity = 64usize;
    loop {
        // Tampon de usize : alignement de la structure.
        let words = list_offset.div_ceil(size_of::<usize>()) + capacity;
        let mut buffer = vec![0usize; words];
        let bytes = words * size_of::<usize>();
        // SAFETY: job valide ; le tampon fait `bytes` octets, aligné.
        let ok = unsafe {
            QueryInformationJobObject(
                job.0,
                JobObjectBasicProcessIdList,
                buffer.as_mut_ptr().cast::<c_void>(),
                u32::try_from(bytes).unwrap_or(u32::MAX),
                std::ptr::null_mut(),
            )
        };
        // SAFETY: lecture de l'erreur du thread courant.
        if ok == 0 && unsafe { GetLastError() } != ERROR_MORE_DATA {
            return Err(NativeError::os(
                "JOB_QUERY_FAILED",
                "QueryInformationJobObject",
            ));
        }
        // SAFETY: le tampon commence par l'en-tête JOBOBJECT_BASIC_PROCESS_ID_LIST.
        let header = unsafe { &*buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
        let assigned = header.NumberOfAssignedProcesses as usize;
        let listed = header.NumberOfProcessIdsInList as usize;
        if ok == 0 || assigned > listed {
            capacity = assigned.max(capacity * 2);
            continue;
        }
        let first = list_offset / size_of::<usize>();
        return Ok(buffer[first..first + listed.min(capacity)]
            .iter()
            .filter_map(|&pid| u32::try_from(pid).ok())
            .collect());
    }
}

/// Issue de `terminate_job` : ce qui est mort et — surtout — ce qui ne l'est
/// pas. Un appelant ne doit jamais conclure « le job est vide » d'un simple
/// `Ok` : seul `survivors.is_empty()` l'établit.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Termination {
    /// PID du job tués (constatés absents à la fin de l'attente).
    pub killed: Vec<u32>,
    /// PID encore présents dans le job à la fin du délai d'attente (ou dont
    /// l'état n'a pu être relu : fail closed, ils sont supposés vivants).
    pub survivors: Vec<u32>,
}

impl Termination {
    pub fn complete(&self) -> bool {
        self.survivors.is_empty()
    }
}

/// Tue tout le job et attend qu'il soit vide ; rend les PID tués ET les
/// survivants éventuels (délai `TERMINATE_WAIT` dépassé).
pub fn terminate_job(job: &OwnedHandle) -> Result<Termination, NativeError> {
    let pids = job_pids(job)?;
    if pids.is_empty() {
        return Ok(Termination::default());
    }
    // SAFETY: job valide.
    if unsafe { TerminateJobObject(job.0, KILLED_EXIT_CODE) } == 0 {
        return Err(NativeError::os(
            "JOB_TERMINATE_FAILED",
            "TerminateJobObject",
        ));
    }
    let deadline = Instant::now() + TERMINATE_WAIT;
    while active_processes(job) != 0 && Instant::now() < deadline {
        std::thread::sleep(TERMINATE_POLL);
    }
    // Relecture après l'attente. Illisible : tous supposés survivants.
    let survivors = if active_processes(job) == 0 {
        Vec::new()
    } else {
        job_pids(job).unwrap_or_else(|_| pids.clone())
    };
    let killed = pids
        .into_iter()
        .filter(|pid| !survivors.contains(pid))
        .collect();
    Ok(Termination { killed, survivors })
}
