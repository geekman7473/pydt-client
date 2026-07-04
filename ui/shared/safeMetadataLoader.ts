import { Injectable, inject } from "@angular/core";
import { Router } from "@angular/router";
import { MetadataCacheService, PydtMetadata } from "pydt-shared";

@Injectable()
export class SafeMetadataLoader {
  metadataCache = inject(MetadataCacheService);
  private router = inject(Router);

  public async loadMetadata(): Promise<PydtMetadata> {
    try {
      return await this.metadataCache.getCivGameMetadata();
    } catch {
      await this.router.navigateByUrl("/?errorLoading=true");
      return null;
    }
  }
}
