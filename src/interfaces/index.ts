export interface Student {
  applicationNumber: string;
  name: string;
  COP: string;
  sgpaValues: string[];
  dob?: string;
}

export interface ParseResult {
  success: boolean;
  applicationNumber: string;
  name: string;
  COP: string;
  sgpaValues: string[];
}

export interface ViewStateParams {
  viewState: string;
  viewStateGenerator: string;
  eventValidation: string;
}

export interface SearchHistory {
  rollNumber: string;
  startYear: number;
  endYear: number;
  startMonth: number;
  endMonth: number;
  usePlaywright: boolean;
  status: 'running' | 'found' | 'not_found' | 'invalid' | 'error' | 'cancelled';
  startedAt: Date;
  finishedAt?: Date;
  result?: {
    name: string;
    applicationNumber: string;
    dob?: string;
  };
  errorMessage?: string;
}
